"""Duplicate detection cascade: SHA-256 → pHash (embedding / feature later)."""

from __future__ import annotations

import logging
from typing import Any, Optional

from app.repositories import media_content_hash as hash_repo
from app.verification.contracts import (
    DuplicateMediaMatch,
    DuplicateReportResult,
    ReasonCode,
    ReportDuplicate,
    ReportSubmittedPayload,
)
from app.verification.hash_compute import (
    PHASH_HAMMING_THRESHOLD,
    hamming_distance_hex,
    prepare_media_hashes,
)

logger = logging.getLogger("ai-service.verification.duplicate")

CONTEXT_MEDIA_HASHES = "media_hashes"


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
    records = _ensure_media_hashes(payload, context)
    winning_report_id: Optional[str] = None
    matches: list[DuplicateMediaMatch] = []

    for rec in records:
        if not rec.sha256:
            continue
        try:
            hit = hash_repo.find_sha256_match_sync(
                rec.sha256,
                user_id=payload.user_id,
                exclude_report_id=payload.report_id,
            )
        except Exception:  # noqa: BLE001
            logger.exception("SHA256 corpus lookup failed")
            raise
        if hit is None:
            continue
        if winning_report_id is None:
            winning_report_id = hit.report_id
        if hit.report_id != winning_report_id:
            continue
        matches.append(
            DuplicateMediaMatch(
                media_id=rec.media_id,
                duplicate_media_id=hit.media_id,
                reason=ReasonCode.EXACT_HASH_MATCH.value,
            )
        )

    if winning_report_id is None:
        return None
    return DuplicateReportResult(
        report_id=payload.report_id,
        duplicate_report_id=winning_report_id,
        reason=ReasonCode.DUPLICATE_IMAGE.value,
        matches=matches,
    )


def phash_similarity(
    payload: ReportSubmittedPayload,
    context: Optional[dict[str, Any]] = None,
) -> Optional[DuplicateReportResult]:
    """Perceptual hash near-duplicate (Hamming ≤ threshold), same user."""
    records = _ensure_media_hashes(payload, context)
    if not any(rec.phash for rec in records):
        return None
    try:
        corpus = hash_repo.list_phash_corpus_sync(
            user_id=payload.user_id,
            exclude_report_id=payload.report_id,
        )
    except Exception:  # noqa: BLE001
        logger.exception("PHASH corpus list failed")
        raise

    if not corpus:
        return None

    best_distance: Optional[int] = None
    winning_report_id: Optional[str] = None
    pairs: list[tuple[int, DuplicateMediaMatch, str]] = []

    for rec in records:
        if not rec.phash:
            continue
        for candidate in corpus:
            try:
                distance = hamming_distance_hex(rec.phash, candidate.hash)
            except ValueError:
                continue
            if distance > PHASH_HAMMING_THRESHOLD:
                continue
            pairs.append(
                (
                    distance,
                    DuplicateMediaMatch(
                        media_id=rec.media_id,
                        duplicate_media_id=candidate.media_id,
                        reason=ReasonCode.HIGH_IMAGE_SIMILARITY.value,
                    ),
                    candidate.report_id,
                )
            )
            if best_distance is None or distance < best_distance:
                best_distance = distance
                winning_report_id = candidate.report_id

    if winning_report_id is None:
        return None

    matches = [
        match
        for distance, match, report_id in pairs
        if report_id == winning_report_id and distance <= PHASH_HAMMING_THRESHOLD
    ]
    return DuplicateReportResult(
        report_id=payload.report_id,
        duplicate_report_id=winning_report_id,
        reason=ReasonCode.DUPLICATE_IMAGE.value,
        matches=matches,
    )


def embedding_similarity(
    payload: ReportSubmittedPayload,
    context: Optional[dict[str, Any]] = None,
) -> Optional[ReportDuplicate]:
    """Embedding-based near-duplicate check. Not implemented yet."""
    _ = (payload, context)
    return None


def feature_matching(
    payload: ReportSubmittedPayload,
    context: Optional[dict[str, Any]] = None,
) -> Optional[ReportDuplicate]:
    """Feature-matching duplicate check. Not implemented yet."""
    _ = (payload, context)
    return None


def run_duplicate_cascade(
    payload: ReportSubmittedPayload,
    context: Optional[dict[str, Any]] = None,
) -> DuplicateReportResult:
    """
    Cascade: SHA-256 → pHash.
    embedding_similarity / feature_matching — implement later.
    """
    ctx = context if context is not None else {}
    _ensure_media_hashes(payload, ctx)
    for step in (exact_hash, phash_similarity):
        # embedding_similarity, feature_matching — implement later
        result = step(payload, ctx)
        if result is not None:
            return result
    return _empty_result(payload)
