"""Persistence for AiMediaContentHash corpus (sync helpers for SQS worker)."""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Optional, Sequence

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app.db.async_bridge import run_coro
from app.db.models import AiMediaContentHash
from app.db.session import SessionLocal
from app.verification.hash_compute import ALG_PHASH, ALG_SHA256, ComputedMediaHashes

logger = logging.getLogger("ai-service.repositories.media_content_hash")


@dataclass
class CorpusHashHit:
    report_id: str
    user_id: Optional[str]
    media_id: str
    hash: str
    algorithm: str


def _parse_uuid(value: str) -> Optional[uuid.UUID]:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError, AttributeError):
        return None


async def _find_sha256_match(
    sha256: str, *, user_id: str, exclude_report_id: str
) -> Optional[CorpusHashHit]:
    exclude = _parse_uuid(exclude_report_id)
    owner = _parse_uuid(user_id)
    if owner is None:
        return None
    async with SessionLocal() as session:
        stmt = select(AiMediaContentHash).where(
            AiMediaContentHash.algorithm == ALG_SHA256,
            AiMediaContentHash.hash == sha256,
            AiMediaContentHash.user_id == owner,
        )
        if exclude is not None:
            stmt = stmt.where(AiMediaContentHash.report_id != exclude)
        stmt = stmt.order_by(AiMediaContentHash.created_at.asc()).limit(1)
        result = await session.execute(stmt)
        row = result.scalar_one_or_none()
        if row is None:
            return None
        return CorpusHashHit(
            report_id=str(row.report_id),
            user_id=str(row.user_id) if row.user_id else None,
            media_id=str(row.media_id),
            hash=row.hash,
            algorithm=row.algorithm,
        )


async def _list_phash_corpus(
    *, user_id: str, exclude_report_id: str
) -> list[CorpusHashHit]:
    exclude = _parse_uuid(exclude_report_id)
    owner = _parse_uuid(user_id)
    if owner is None:
        return []
    async with SessionLocal() as session:
        stmt = select(AiMediaContentHash).where(
            AiMediaContentHash.algorithm == ALG_PHASH,
            AiMediaContentHash.user_id == owner,
        )
        if exclude is not None:
            stmt = stmt.where(AiMediaContentHash.report_id != exclude)
        result = await session.execute(stmt)
        rows = list(result.scalars().all())
        return [
            CorpusHashHit(
                report_id=str(r.report_id),
                user_id=str(r.user_id) if r.user_id else None,
                media_id=str(r.media_id),
                hash=r.hash,
                algorithm=r.algorithm,
            )
            for r in rows
        ]


async def _upsert_computed_hashes(
    *,
    report_id: str,
    user_id: str,
    records: Sequence[ComputedMediaHashes],
) -> None:
    report_uuid = _parse_uuid(report_id)
    user_uuid = _parse_uuid(user_id)
    if report_uuid is None:
        logger.warning("skip upsert: invalid report_id=%s", report_id)
        return

    rows: list[dict] = []
    for rec in records:
        media_uuid = _parse_uuid(rec.media_id)
        file_uuid = _parse_uuid(rec.report_media_file_id)
        if media_uuid is None or file_uuid is None:
            continue
        base = {
            "report_id": report_uuid,
            "report_media_file_id": file_uuid,
            "media_id": media_uuid,
            "user_id": user_uuid,
        }
        if rec.sha256:
            rows.append({**base, "algorithm": ALG_SHA256, "hash": rec.sha256})
        if rec.phash:
            rows.append({**base, "algorithm": ALG_PHASH, "hash": rec.phash})

    if not rows:
        logger.warning(
            "skip upsert: no hash rows report_id=%s records=%s",
            report_id,
            len(records),
        )
        return

    async with SessionLocal() as session:
        stmt = insert(AiMediaContentHash).values(rows)
        stmt = stmt.on_conflict_do_update(
            constraint="uq_ai_media_hash_media_algo",
            set_={
                "hash": stmt.excluded.hash,
                "report_id": stmt.excluded.report_id,
                "report_media_file_id": stmt.excluded.report_media_file_id,
                "user_id": stmt.excluded.user_id,
            },
        )
        await session.execute(stmt)
        await session.commit()
        logger.info(
            "upserted media content hashes report_id=%s rows=%s",
            report_id,
            len(rows),
        )


def find_sha256_match_sync(
    sha256: str, *, user_id: str, exclude_report_id: str
) -> Optional[CorpusHashHit]:
    return run_coro(
        _find_sha256_match(
            sha256, user_id=user_id, exclude_report_id=exclude_report_id
        )
    )


def list_phash_corpus_sync(
    *, user_id: str, exclude_report_id: str
) -> list[CorpusHashHit]:
    return run_coro(
        _list_phash_corpus(user_id=user_id, exclude_report_id=exclude_report_id)
    )


def upsert_computed_hashes_sync(
    *,
    report_id: str,
    user_id: str,
    records: Sequence[ComputedMediaHashes],
) -> None:
    run_coro(
        _upsert_computed_hashes(
            report_id=report_id, user_id=user_id, records=records
        )
    )
