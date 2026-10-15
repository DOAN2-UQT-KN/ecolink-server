"""DuplicateCheck cascade (specs/006 P06, design "DuplicateCheck").

Cheapest first, stop at the first matching tier:
  1. pHash <= phash_global_max against the whole corpus (one XOR per row in Postgres)
  2. pHash <= phash_candidate_max against candidates (radius / days around the report)
  3. ORB + RANSAC against the same candidates
  4. internet: not implemented, always NOT_AVAILABLE
The new image is also compared as a horizontal mirror. Location and time only select
candidates; they never add risk.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Optional, Sequence, TypeVar

from starlette.concurrency import run_in_threadpool

from app.clients.incident_internal import inactive_report_ids_sync
from app.config import settings
from app.verification.duplicate.orb import OrbFeatures, OrbMatchConfig, extract_orb, verify_orb_pair
from app.verification.duplicate_check.corpus import (
    CorpusImage,
    CorpusPort,
    CorpusReport,
    OrbCandidate,
    PhashCandidate,
    PhashHit,
)
from app.verification.duplicate_check.geo import haversine_m, hours_between
from app.verification.duplicate_check.models import CheckResultOut, DuplicateCheckRequest, SignalOut
from app.verification.hash_compute import (
    compute_phash_hex,
    download_image_bytes,
    hamming_int,
    mirror_image_bytes,
    phash_hex_to_int,
)

logger = logging.getLogger("ai-service.verification.duplicate_check")

DOWNLOAD_TIMEOUT_S = 6.0
REASON_NEAR_IMAGE = "DUP_NEAR_IMAGE_MATCH"
REASON_FEATURE = "DUP_FEATURE_MATCH"

Row = TypeVar("Row", PhashHit, PhashCandidate, OrbCandidate)


@dataclass
class _Image:
    index: int
    media_id: str
    report_media_file_id: str
    phash_hex: str
    q: int
    q_flip: int
    data: bytes
    flipped_data: Optional[bytes]
    orb: Optional[OrbFeatures] = None
    orb_flipped: Optional[OrbFeatures] = None


@dataclass
class _Match:
    method: str
    image: _Image
    row: Any
    flipped: bool
    phash_distance: Optional[int] = None
    inliers: Optional[int] = None


def _prepare(index: int, media_id: str, rmf_id: str, url: str) -> Optional[_Image]:
    data = download_image_bytes(url, timeout=DOWNLOAD_TIMEOUT_S)
    if not data:
        return None
    phash = compute_phash_hex(data)
    if not phash:
        return None
    flipped = mirror_image_bytes(data)
    flipped_phash = compute_phash_hex(flipped) if flipped else None
    q = phash_hex_to_int(phash)
    return _Image(
        index=index,
        media_id=media_id,
        report_media_file_id=rmf_id,
        phash_hex=phash,
        q=q,
        q_flip=phash_hex_to_int(flipped_phash) if flipped_phash else q,
        data=data,
        flipped_data=flipped,
    )


def _ensure_orb(img: _Image) -> None:
    if img.orb is None:
        img.orb = extract_orb(img.data, media_id=img.media_id)
    if img.orb_flipped is None and img.flipped_data:
        img.orb_flipped = extract_orb(img.flipped_data, media_id=img.media_id)


def _best_orb(images: Sequence[_Image], candidates: Sequence[OrbCandidate], cfg: OrbMatchConfig) -> Optional[_Match]:
    """CPU-bound: runs in a worker thread."""
    best: Optional[_Match] = None
    for img in images:
        _ensure_orb(img)
        for flipped, query in ((False, img.orb), (True, img.orb_flipped)):
            if query is None or query.keypoint_count == 0:
                continue
            for cand in candidates:
                result = verify_orb_pair(query, cand.features, config=cfg)
                if result.is_duplicate and (best is None or result.inlier_count > (best.inliers or 0)):
                    best = _Match("orb", img, cand, flipped, inliers=result.inlier_count)
    return best


async def _drop_inactive(rows: list[Row]) -> list[Row]:
    """Reports that were rejected or deleted are never duplicates (FR-017)."""
    ids = list({row.report_id for row in rows})
    if not ids:
        return rows
    inactive = await run_in_threadpool(inactive_report_ids_sync, ids)
    return [row for row in rows if row.report_id not in inactive]


def _signals(phash: SignalOut, orb: SignalOut) -> list[SignalOut]:
    return [phash, orb, SignalOut(name="internet", status="NOT_AVAILABLE")]


def _match_evidence(req: DuplicateCheckRequest, m: _Match) -> dict[str, Any]:
    row = m.row
    evidence: dict[str, Any] = {
        "report_id": row.report_id,
        "user_id": row.user_id,
        "same_user": row.user_id is not None and row.user_id == req.user_id,
        "method": m.method,
        "image_index": m.image.index,
        "flipped": m.flipped,
        "distance_m": None,
        "time_delta_hours": None,
    }
    if m.phash_distance is not None:
        evidence["phash_distance"] = m.phash_distance
    if m.inliers is not None:
        evidence["inliers"] = m.inliers
    if None not in (req.latitude, req.longitude, row.latitude, row.longitude):
        evidence["distance_m"] = round(haversine_m(req.latitude, req.longitude, row.latitude, row.longitude))
    if row.report_created_at is not None:
        evidence["time_delta_hours"] = round(hours_between(req.created_at, row.report_created_at), 1)
    return evidence


def _failed(req: DuplicateCheckRequest, code: str, message: str, started: float) -> CheckResultOut:
    return CheckResultOut(
        version=req.config.version,
        status="FAILED",
        signals=_signals(SignalOut(name="phash", status="FAILED"), SignalOut(name="orb", status="FAILED")),
        error={"code": code, "message": message},
        duration_ms=round((time.perf_counter() - started) * 1000),
    )


async def run_duplicate_check(req: DuplicateCheckRequest, corpus: CorpusPort) -> CheckResultOut:
    started = time.perf_counter()
    cfg = req.config

    prepared = await asyncio.gather(
        *(
            run_in_threadpool(_prepare, i, m.media_id, m.report_media_file_id, m.url)
            for i, m in enumerate(req.media)
        )
    )
    images = [img for img in prepared if img is not None]
    images_failed = len(prepared) - len(images)
    if not images:
        return _failed(req, "DOWNLOAD_FAILED", "no image could be downloaded or hashed", started)

    try:
        match, risk, min_distance, candidates_scanned, best_inliers = await _cascade(req, images, corpus)
    except Exception as err:  # noqa: BLE001 — DB / inactive-ids errors become a FAILED check
        logger.exception("duplicate check failed report_id=%s", req.report_id)
        return _failed(req, "ERROR", str(err), started)

    has_geo = req.latitude is not None and req.longitude is not None
    if match is not None and match.method == "phash":
        phash = SignalOut(name="phash", status="COMPLETED", risk=risk, raw=match.phash_distance)
        orb = SignalOut(name="orb", status="SKIPPED")
        reasons = [REASON_NEAR_IMAGE]
    elif match is not None:
        phash = SignalOut(name="phash", status="COMPLETED", risk=0, raw=min_distance)
        orb = SignalOut(name="orb", status="COMPLETED", risk=risk, raw=match.inliers)
        reasons = [REASON_FEATURE]
    else:
        phash = SignalOut(name="phash", status="COMPLETED", risk=0, raw=min_distance)
        orb = (
            SignalOut(name="orb", status="COMPLETED", risk=0, raw=best_inliers)
            if has_geo
            else SignalOut(name="orb", status="SKIPPED")
        )
        reasons = []

    result = CheckResultOut(
        version=cfg.version,
        status="COMPLETED",
        risk=risk if match is not None else 0,
        reasons=reasons,
        signals=_signals(phash, orb),
        evidence={
            "candidates_scanned": candidates_scanned,
            "images_failed": images_failed,
            "match": _match_evidence(req, match) if match is not None else None,
        },
        duration_ms=round((time.perf_counter() - started) * 1000),
    )

    # Matched images stay out of the corpus; a failed write must not change the verdict.
    keep = [img for img in images if match is None or img.media_id != match.image.media_id]
    try:
        await run_in_threadpool(lambda: [_ensure_orb(img) for img in keep])
        await corpus.upsert(
            report=CorpusReport(
                report_id=req.report_id,
                user_id=req.user_id,
                latitude=req.latitude,
                longitude=req.longitude,
                created_at=req.created_at,
                category=req.category,
            ),
            images=[
                CorpusImage(img.media_id, img.report_media_file_id, img.phash_hex, img.orb) for img in keep
            ],
        )
    except Exception:  # noqa: BLE001
        logger.exception("corpus upsert failed report_id=%s", req.report_id)
    return result


async def _cascade(
    req: DuplicateCheckRequest, images: list[_Image], corpus: CorpusPort
) -> tuple[Optional[_Match], Optional[float], Optional[int], int, Optional[int]]:
    """Returns (match, risk, smallest candidate pHash distance seen, candidates scanned, best ORB inliers)."""
    cfg = req.config

    # Tier 1: strict pHash over the whole corpus.
    best: Optional[_Match] = None
    for img in images:
        hits = await _drop_inactive(
            await corpus.find_global_phash(
                q=img.q,
                q_flip=img.q_flip,
                max_distance=cfg.phash_global_max,
                exclude_report_id=req.report_id,
            )
        )
        for hit in hits:
            if best is None or hit.distance < (best.phash_distance or 0):
                best = _Match("phash", img, hit, hit.flipped, phash_distance=hit.distance)
    if best is not None:
        return best, cfg.risk.phash_strict, best.phash_distance, 0, None

    if req.latitude is None or req.longitude is None:
        return None, None, None, 0, None

    since = req.created_at - timedelta(days=cfg.candidate_days)
    geo = dict(
        lat=req.latitude,
        lng=req.longitude,
        radius_m=cfg.candidate_radius_m,
        since=since,
        exclude_report_id=req.report_id,
    )

    # Tier 2: loose pHash over candidates.
    phash_cands = await _drop_inactive(await corpus.list_phash_candidates(**geo))
    min_distance: Optional[int] = None
    for img in images:
        for cand in phash_cands:
            d, d_flip = hamming_int(img.q, cand.phash_int), hamming_int(img.q_flip, cand.phash_int)
            distance = min(d, d_flip)
            if min_distance is None or distance < min_distance:
                min_distance = distance
            if distance <= cfg.phash_candidate_max and (best is None or distance < (best.phash_distance or 0)):
                best = _Match("phash", img, cand, d_flip < d, phash_distance=distance)
    if best is not None:
        return best, cfg.risk.phash_loose, min_distance, len(phash_cands), None

    # Tier 3: ORB + RANSAC over candidates.
    orb_cands = await _drop_inactive(await corpus.list_orb_candidates(**geo))
    scanned = len({c.media_id for c in phash_cands} | {c.media_id for c in orb_cands})
    orb_cfg = OrbMatchConfig(
        ratio_threshold=settings.orb_ratio_threshold,
        min_good_matches=settings.orb_min_good_matches,
        min_inlier_count=cfg.orb_min_inliers,
        min_inlier_ratio=cfg.orb_min_inlier_ratio,
        ransac_reproj_threshold=settings.orb_ransac_reproj_threshold,
    )
    best = await run_in_threadpool(_best_orb, images, orb_cands, orb_cfg) if orb_cands else None
    if best is not None:
        return best, cfg.risk.orb, min_distance, scanned, best.inliers
    return None, None, min_distance, scanned, None
