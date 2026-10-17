"""DuplicateCheck signal `internet`: reverse image search (specs/011).

Runs only when phash and orb found nothing. Library (GALLERY) images, at most `max_images`, go
through Vision WEB_DETECTION in batches of `batch_size`; a later batch runs only when the
previous one matched nothing. Web images are only candidates: one counts as a match after it is
downloaded and passes the same pHash / ORB thresholds as the internal candidates.
An error here only fails this signal; the check keeps the phash / orb result (FR-019).
"""

from __future__ import annotations

import asyncio
import html
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, Sequence
from urllib.parse import urlsplit

from starlette.concurrency import run_in_threadpool

from app.verification.duplicate.orb import OrbMatchConfig, extract_orb, verify_orb_pair
from app.verification.duplicate_check.images import PreparedImage, ensure_orb, orb_match_config
from app.verification.duplicate_check.models import DuplicateCheckRequest, SignalOut, WebConfig
from app.verification.duplicate_check.vision import VisionError
from app.verification.duplicate_check.web_store import WebStorePort
from app.verification.hash_compute import compute_phash_hex, hamming_int, phash_hex_to_int

logger = logging.getLogger("ai-service.verification.internet")

REASON_WEB_IMAGE = "DUP_WEB_IMAGE_MATCH"
_TAG = re.compile(r"<[^>]+>")


class VisionPort(Protocol):
    async def web_detection(self, image: bytes, *, max_results: int, timeout_s: float) -> dict[str, Any]: ...


class FetcherPort(Protocol):
    async def fetch_all(self, urls: Sequence[str], *, timeout_s: float, max_bytes: int) -> list[Optional[bytes]]: ...


@dataclass
class WebDeps:
    store: WebStorePort
    vision: Optional[VisionPort]
    fetcher: FetcherPort


@dataclass
class InternetResult:
    signal: SignalOut
    match: Optional[dict[str, Any]] = None
    web: Optional[dict[str, Any]] = None

    @property
    def risk(self) -> Optional[float]:
        return self.signal.risk if self.match is not None else None


@dataclass
class _Outcome:
    image: PreparedImage
    kind: str  # hit | miss | failed | quota
    hit: Optional[dict[str, Any]] = None
    cache_hit: bool = False
    vision_candidates: int = 0
    after_filter: int = 0
    downloaded: int = 0
    failed_candidates: list[dict[str, Any]] = field(default_factory=list)


# ── candidates ────────────────────────────────────────────────────────────────


def _blocked(url: str, hosts: Sequence[str], prefixes: Sequence[str]) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    if any(host == h.lower() or host.endswith("." + h.lower()) for h in hosts if h):
        return True
    return any(url.startswith(p) for p in prefixes if p)


def filter_candidates(
    web_detection: dict[str, Any], *, blocked_hosts: Sequence[str], blocked_url_prefixes: Sequence[str], limit: int
) -> list[dict[str, Any]]:
    """Full matches first, then partial ones; visually similar images are dropped (FR-007)."""
    pages: dict[str, tuple[str, Optional[str]]] = {}
    for page in web_detection.get("pagesWithMatchingImages") or []:
        page_url = page.get("url")
        if not isinstance(page_url, str):
            continue
        raw_title = page.get("pageTitle")
        title = html.unescape(_TAG.sub("", raw_title)).strip() or None if isinstance(raw_title, str) else None
        for key in ("fullMatchingImages", "partialMatchingImages"):
            for image in page.get(key) or []:
                pages.setdefault(image.get("url"), (page_url, title))

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for key, match_type in (("fullMatchingImages", "FULL"), ("partialMatchingImages", "PARTIAL")):
        for image in web_detection.get(key) or []:
            url = image.get("url")
            if not isinstance(url, str) or not url.startswith("https://") or url in seen:
                continue
            if _blocked(url, blocked_hosts, blocked_url_prefixes):
                continue
            seen.add(url)
            page_url, title = pages.get(url, (None, None))
            out.append({"image_url": url, "page_url": page_url, "page_title": title, "match_type": match_type})
    return out[:limit]


def _vision_count(web_detection: dict[str, Any]) -> int:
    return len(web_detection.get("fullMatchingImages") or []) + len(web_detection.get("partialMatchingImages") or [])


# ── verification ──────────────────────────────────────────────────────────────


def _verify_downloaded(
    img: PreparedImage,
    candidates: Sequence[dict[str, Any]],
    blobs: Sequence[Optional[bytes]],
    phash_max: int,
    orb_cfg: OrbMatchConfig,
) -> Optional[dict[str, Any]]:
    """CPU-bound: runs in a worker thread. First candidate passing pHash, else ORB, wins."""
    for cand, data in zip(candidates, blobs):
        if not data:
            continue
        phash = compute_phash_hex(data)
        if phash:
            h = phash_hex_to_int(phash)
            d, d_flip = hamming_int(img.q, h), hamming_int(img.q_flip, h)
            if min(d, d_flip) <= phash_max:
                return {**cand, "verified_by": "phash", "phash_distance": min(d, d_flip), "flipped": d_flip < d}
        ensure_orb(img)
        web = extract_orb(data, media_id="web")
        if web is None or web.keypoint_count == 0:
            continue
        for flipped, query in ((False, img.orb), (True, img.orb_flipped)):
            if query is None or query.keypoint_count == 0:
                continue
            result = verify_orb_pair(query, web, config=orb_cfg)
            if result.is_duplicate:
                return {**cand, "verified_by": "orb", "inliers": result.inlier_count, "flipped": flipped}
    return None


async def _check_image(
    img: PreparedImage, req: DuplicateCheckRequest, web: WebConfig, deps: WebDeps, orb_cfg: OrbMatchConfig
) -> _Outcome:
    candidates = await deps.store.get_candidates(img.phash_hex)
    outcome = _Outcome(img, "miss", cache_hit=candidates is not None)
    if candidates is None:
        try:
            if not await deps.store.reserve_call(web.daily_limit):
                return _Outcome(img, "quota")
        except Exception:  # noqa: BLE001 — never call Vision without knowing the quota
            logger.exception("web quota counter failed report_id=%s", req.report_id)
            return _Outcome(img, "failed")
        assert deps.vision is not None
        try:
            result = await deps.vision.web_detection(
                img.data, max_results=web.max_results, timeout_s=web.call_timeout_ms / 1000
            )
        except VisionError as err:
            logger.warning("vision failed report_id=%s err=%s", req.report_id, err)
            return _Outcome(img, "failed")
        outcome.vision_candidates = _vision_count(result)
        candidates = filter_candidates(
            result,
            blocked_hosts=web.blocked_hosts,
            blocked_url_prefixes=web.blocked_url_prefixes,
            limit=web.max_candidates,
        )
        await deps.store.put_candidates(img.phash_hex, candidates, web.cache_ttl_days)
    else:
        outcome.vision_candidates = len(candidates)
    outcome.after_filter = len(candidates)
    if not candidates:
        return outcome

    blobs = await deps.fetcher.fetch_all(
        [c["image_url"] for c in candidates], timeout_s=web.fetch_timeout_ms / 1000, max_bytes=web.fetch_max_bytes
    )
    outcome.downloaded = sum(1 for b in blobs if b)
    if outcome.downloaded == 0 and any(c.get("match_type") == "FULL" for c in candidates):
        # A full match we could not check is not clean either: let the moderator open it.
        outcome.kind = "failed"
        outcome.failed_candidates = list(candidates)
        return outcome
    hit = await run_in_threadpool(
        _verify_downloaded, img, candidates, blobs, req.config.phash_candidate_max, orb_cfg
    )
    if hit is not None:
        outcome.kind, outcome.hit = "hit", hit
    return outcome


# ── signal ────────────────────────────────────────────────────────────────────


def _gallery(req: DuplicateCheckRequest, images: Sequence[PreparedImage], limit: int) -> list[PreparedImage]:
    picked = [
        img
        for img in sorted(images, key=lambda i: i.index)
        if img.index < len(req.media) and req.media[img.index].capture_source == "GALLERY"
    ]
    return picked[:limit]


def _web_block(status: str, outcomes: Sequence[_Outcome]) -> dict[str, Any]:
    sent = [o for o in outcomes if o.kind != "quota"]
    block: dict[str, Any] = {
        "status": status,
        "gallery_sent": len(sent),
        "cache_hit": bool(sent) and all(o.cache_hit for o in sent),
        "vision_candidates": sum(o.vision_candidates for o in sent),
        "after_filter": sum(o.after_filter for o in sent),
        "downloaded": sum(o.downloaded for o in sent),
    }
    failed = [c for o in outcomes for c in o.failed_candidates]
    if status == "FAILED" and failed:
        block["candidates"] = [
            {k: c.get(k) for k in ("image_url", "page_url", "page_title", "match_type")} for c in failed
        ]
    return block


async def _run_batches(
    req: DuplicateCheckRequest, gallery: list[PreparedImage], web: WebConfig, deps: WebDeps, outcomes: list[_Outcome]
) -> str:
    orb_cfg = orb_match_config(req.config.orb_min_inliers, req.config.orb_min_inlier_ratio)
    size = max(1, web.batch_size)
    for start in range(0, len(gallery), size):
        batch = await asyncio.gather(*(_check_image(img, req, web, deps, orb_cfg) for img in gallery[start : start + size]))
        outcomes.extend(batch)
        if any(o.kind == "hit" for o in batch):
            return "hit"
        if any(o.kind == "failed" for o in batch):
            return "failed"
        if any(o.kind == "quota" for o in batch):
            return "quota"
    return "miss"


async def run_internet_signal(
    req: DuplicateCheckRequest, images: Sequence[PreparedImage], deps: Optional[WebDeps]
) -> InternetResult:
    web = req.config.web
    if web is None or not web.enabled or deps is None or deps.vision is None:
        return InternetResult(SignalOut(name="internet", status="NOT_AVAILABLE"))
    gallery = _gallery(req, images, web.max_images)
    if not gallery:
        return InternetResult(SignalOut(name="internet", status="SKIPPED"))

    started = time.perf_counter()
    outcomes: list[_Outcome] = []
    try:
        verdict = await asyncio.wait_for(_run_batches(req, gallery, web, deps, outcomes), web.total_timeout_ms / 1000)
    except asyncio.TimeoutError:
        verdict = "failed"
    except Exception:  # noqa: BLE001 — never let this signal fail the whole check
        logger.exception("internet signal failed report_id=%s", req.report_id)
        verdict = "failed"

    if verdict == "hit":
        best = min((o for o in outcomes if o.kind == "hit"), key=lambda o: o.image.index)
        hit = best.hit or {}
        match = {
            "method": "internet",
            "image_index": best.image.index,
            "match_type": hit.get("match_type"),
            "verified_by": hit.get("verified_by"),
            "phash_distance": hit.get("phash_distance"),
            "inliers": hit.get("inliers"),
            "flipped": hit.get("flipped", False),
            "source_url": hit.get("image_url"),
            "page_url": hit.get("page_url"),
            "page_title": hit.get("page_title"),
        }
        raw = hit.get("phash_distance") if hit.get("verified_by") == "phash" else hit.get("inliers")
        result = InternetResult(
            SignalOut(name="internet", status="COMPLETED", risk=req.config.risk.internet, raw=raw),
            match=match,
            web=_web_block("COMPLETED", outcomes),
        )
    elif verdict == "miss":
        measured = sum(o.downloaded for o in outcomes)
        result = InternetResult(
            SignalOut(name="internet", status="COMPLETED", risk=0, raw=measured), web=_web_block("COMPLETED", outcomes)
        )
    elif verdict == "quota":
        result = InternetResult(SignalOut(name="internet", status="NOT_AVAILABLE"), web=_web_block("NOT_AVAILABLE", outcomes))
    else:
        result = InternetResult(SignalOut(name="internet", status="FAILED"), web=_web_block("FAILED", outcomes))

    logger.info(
        "internet signal report_id=%s status=%s gallery_sent=%s cache_hit=%s vision_candidates=%s duration_ms=%s",
        req.report_id,
        result.signal.status,
        result.web["gallery_sent"] if result.web else 0,
        result.web["cache_hit"] if result.web else False,
        result.web["vision_candidates"] if result.web else 0,
        round((time.perf_counter() - started) * 1000),
    )
    return result
