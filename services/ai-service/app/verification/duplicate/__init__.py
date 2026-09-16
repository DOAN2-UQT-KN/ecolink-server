"""Duplicate detection cascade: SHA-256 → pHash → ORB (embedding later)."""

from __future__ import annotations

import logging
from typing import Any, Optional

from app.clients.incident_internal import inactive_report_ids_sync
from app.repositories import media_content_hash as hash_repo
from app.repositories.media_orb_feature import list_for_user_sync
from app.verification.contracts import (
    DuplicateMediaMatch,
    DuplicateReportResult,
    ReasonCode,
    ReportDuplicate,
    ReportSubmittedPayload,
)
from app.verification.duplicate.orb import (
    OrbFeatures,
    config_from_settings,
    extract_orb,
    verify_orb_pair,
)
from app.verification.hash_compute import (
    PHASH_HAMMING_THRESHOLD,
    ComputedMediaHashes,
    hamming_distance_hex,
    prepare_media_hashes,
)

logger = logging.getLogger("ai-service.verification.duplicate")

CONTEXT_MEDIA_HASHES = "media_hashes"
CONTEXT_MATCHED_MEDIA_IDS = "matched_media_ids"
CONTEXT_INACTIVE_REPORT_IDS = "inactive_report_ids"
CONTEXT_STATUS_CHECKED_IDS = "status_checked_report_ids"


def _matched_media_ids(context: Optional[dict[str, Any]]) -> set[str]:
    if not context:
        return set()
    raw = context.get(CONTEXT_MATCHED_MEDIA_IDS)
    if isinstance(raw, set):
        return raw
    return set()


def _inactive_report_ids(
    report_ids: list[str],
    context: Optional[dict[str, Any]],
) -> set[str]:
    """Banned or deleted report ids. Cached on the cascade context."""
    ctx = context if context is not None else {}
    inactive = ctx.get(CONTEXT_INACTIVE_REPORT_IDS)
    checked = ctx.get(CONTEXT_STATUS_CHECKED_IDS)
    if not isinstance(inactive, set):
        inactive = set()
        if context is not None:
            ctx[CONTEXT_INACTIVE_REPORT_IDS] = inactive
    if not isinstance(checked, set):
        checked = set()
        if context is not None:
            ctx[CONTEXT_STATUS_CHECKED_IDS] = checked
    pending = [report_id for report_id in dict.fromkeys(report_ids) if report_id and report_id not in checked]
    if pending:
        found = inactive_report_ids_sync(pending)
        checked.update(pending)
        inactive.update(found)
    return inactive


def _drop_inactive(rows: list[Any], context: Optional[dict[str, Any]]) -> list[Any]:
    if not rows:
        return rows
    inactive = _inactive_report_ids(
        [row.report_id for row in rows],
        context,
    )
    if not inactive:
        return rows
    return [row for row in rows if row.report_id not in inactive]


def _report_ids(matches: list[DuplicateMediaMatch]) -> list[str]:
    ids: list[str] = []
    for match in matches:
        report_id = match.duplicate_report_id
        if report_id and report_id not in ids:
            ids.append(report_id)
    return ids


def _result_from_matches(
    payload: ReportSubmittedPayload,
    matches: list[DuplicateMediaMatch],
) -> Optional[DuplicateReportResult]:
    if not matches:
        return None
    return DuplicateReportResult(
        report_id=payload.report_id,
        duplicate_report_ids=_report_ids(matches),
        reason=ReasonCode.DUPLICATE_IMAGE.value,
        matches=matches,
    )


def _empty_result(payload: ReportSubmittedPayload) -> DuplicateReportResult:
    return DuplicateReportResult(report_id=payload.report_id)


def _ensure_media_hashes(
    payload: ReportSubmittedPayload,
    context: Optional[dict[str, Any]],
) -> list:
    ctx = context if context is not None else {}
    existing = ctx.get(CONTEXT_MEDIA_HASHES)
    if existing is not None:
        return existing
    prepared = prepare_media_hashes(payload)
    ctx[CONTEXT_MEDIA_HASHES] = prepared
    return prepared


def exact_hash(
    payload: ReportSubmittedPayload,
    context: Optional[dict[str, Any]] = None,
) -> Optional[DuplicateReportResult]:
    """Exact SHA-256 duplicate of an existing report by the same user."""
    logger.info(
        "duplicate check start step=exact_hash report_id=%s",
        payload.report_id,
    )
    records = _ensure_media_hashes(payload, context)
    matched = _matched_media_ids(context)
    matches: list[DuplicateMediaMatch] = []
    seen: set[tuple[str, str, str]] = set()

    for rec in records:
        if not rec.sha256 or rec.media_id in matched:
            continue
        try:
            hits = hash_repo.find_sha256_matches_sync(
                rec.sha256,
                user_id=payload.user_id,
                exclude_report_id=payload.report_id,
            )
        except Exception:  # noqa: BLE001
            logger.exception("SHA256 corpus lookup failed")
            raise
        for hit in _drop_inactive(hits, context):
            key = (rec.media_id, hit.media_id, hit.report_id)
            if key in seen:
                continue
            seen.add(key)
            matches.append(
                DuplicateMediaMatch(
                    media_id=rec.media_id,
                    duplicate_media_id=hit.media_id,
                    duplicate_report_id=hit.report_id,
                    reason=ReasonCode.EXACT_HASH_MATCH.value,
                )
            )

    return _result_from_matches(payload, matches)


def phash_similarity(
    payload: ReportSubmittedPayload,
    context: Optional[dict[str, Any]] = None,
) -> Optional[DuplicateReportResult]:
    """Perceptual hash near-duplicate (Hamming ≤ threshold), same user."""
    logger.info(
        "duplicate check start step=phash_similarity report_id=%s",
        payload.report_id,
    )
    records = [
        rec
        for rec in _ensure_media_hashes(payload, context)
        if rec.phash and rec.media_id not in _matched_media_ids(context)
    ]
    if not records:
        return None
    try:
        corpus = hash_repo.list_phash_corpus_sync(
            user_id=payload.user_id,
            exclude_report_id=payload.report_id,
        )
    except Exception:  # noqa: BLE001
        logger.exception("PHASH corpus list failed")
        raise

    corpus = _drop_inactive(corpus, context)
    if not corpus:
        return None

    matches: list[DuplicateMediaMatch] = []
    seen: set[tuple[str, str, str]] = set()

    for rec in records:
        for candidate in corpus:
            try:
                distance = hamming_distance_hex(rec.phash, candidate.hash)
            except ValueError:
                continue
            if distance > PHASH_HAMMING_THRESHOLD:
                continue
            key = (rec.media_id, candidate.media_id, candidate.report_id)
            if key in seen:
                continue
            seen.add(key)
            matches.append(
                DuplicateMediaMatch(
                    media_id=rec.media_id,
                    duplicate_media_id=candidate.media_id,
                    duplicate_report_id=candidate.report_id,
                    reason=ReasonCode.HIGH_IMAGE_SIMILARITY.value,
                )
            )

    return _result_from_matches(payload, matches)


def embedding_similarity(
    payload: ReportSubmittedPayload,
    context: Optional[dict[str, Any]] = None,
) -> Optional[ReportDuplicate]:
    """Embedding-based near-duplicate check. Not implemented yet."""
    logger.info(
        "duplicate check start step=embedding_similarity report_id=%s",
        payload.report_id,
    )
    _ = context
    return None


def _attach_orb(records: list[ComputedMediaHashes]) -> list[OrbFeatures]:
    prepared: list[OrbFeatures] = []
    for rec in records:
        features = rec.orb
        if features is None and rec.image_bytes:
            features = extract_orb(rec.image_bytes, media_id=rec.media_id)
            rec.orb = features if features.keypoint_count else None
            features = rec.orb
        if features is None or features.keypoint_count == 0:
            continue
        if not features.media_id:
            features.media_id = rec.media_id
        prepared.append(features)
    return prepared


def feature_matching(
    payload: ReportSubmittedPayload,
    context: Optional[dict[str, Any]] = None,
) -> Optional[DuplicateReportResult]:
    """ORB feature match against other reports by the same user."""
    logger.info(
        "duplicate check start step=feature_matching report_id=%s",
        payload.report_id,
    )
    records = _ensure_media_hashes(payload, context)
    _attach_orb(records)
    matched = _matched_media_ids(context)
    queries = [
        features
        for rec in records
        if rec.media_id not in matched and rec.orb is not None and rec.orb.keypoint_count
        for features in [rec.orb]
    ]
    if not queries:
        return None
    try:
        corpus = list_for_user_sync(
            user_id=payload.user_id,
            exclude_report_id=payload.report_id,
        )
    except Exception:  # noqa: BLE001
        logger.exception("ORB corpus list failed")
        raise
    corpus = _drop_inactive(corpus, context)
    if not corpus:
        return None

    config = config_from_settings()
    matches: list[DuplicateMediaMatch] = []
    seen: set[tuple[str, str, str]] = set()

    for query in queries:
        for candidate in corpus:
            result = verify_orb_pair(query, candidate.features, config=config)
            logger.info(
                "ORB verify query_media_id=%s matched_media_id=%s good=%s inliers=%s ratio=%.3f duplicate=%s",
                query.media_id,
                result.matched_media_id,
                result.good_match_count,
                result.inlier_count,
                result.inlier_ratio,
                result.is_duplicate,
            )
            if not result.is_duplicate:
                continue
            key = (query.media_id, result.matched_media_id, candidate.report_id)
            if key in seen:
                continue
            seen.add(key)
            matches.append(
                DuplicateMediaMatch(
                    media_id=query.media_id,
                    duplicate_media_id=result.matched_media_id,
                    duplicate_report_id=candidate.report_id,
                    reason=ReasonCode.FEATURE_MATCH.value,
                )
            )

    return _result_from_matches(payload, matches)


def run_duplicate_cascade(
    payload: ReportSubmittedPayload,
    context: Optional[dict[str, Any]] = None,
) -> DuplicateReportResult:
    """
    Cascade: scan every image with SHA-256, then pHash, then ORB.
    A later step runs only for images that have no match yet.
    """
    ctx = context if context is not None else {}
    _ensure_media_hashes(payload, ctx)
    matched: set[str] = set()
    ctx[CONTEXT_MATCHED_MEDIA_IDS] = matched
    matches: list[DuplicateMediaMatch] = []
    for step in (exact_hash, phash_similarity, feature_matching):
        result = step(payload, ctx)
        if result is None:
            continue
        for match in result.matches:
            matches.append(match)
            matched.add(match.media_id)
    if not matches:
        return _empty_result(payload)
    return DuplicateReportResult(
        report_id=payload.report_id,
        duplicate_report_ids=_report_ids(matches),
        reason=ReasonCode.DUPLICATE_IMAGE.value,
        matches=matches,
    )
