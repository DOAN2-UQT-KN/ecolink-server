"""Persistence for stored ORB keypoints/descriptors (sync helpers for SQS worker)."""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Optional, Sequence

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert

from app.db.async_bridge import run_coro
from app.db.models import AiMediaOrbFeature
from app.db.session import SessionLocal
from app.verification.duplicate.orb import OrbFeatures, pack_array, unpack_array
from app.verification.hash_compute import ComputedMediaHashes

logger = logging.getLogger("ai-service.repositories.media_orb_feature")


@dataclass
class CorpusOrbFeature:
    report_id: str
    user_id: Optional[str]
    media_id: str
    features: OrbFeatures


def _parse_uuid(value: str) -> Optional[uuid.UUID]:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError, AttributeError):
        return None


def _features_from_row(row: AiMediaOrbFeature) -> Optional[OrbFeatures]:
    try:
        keypoints = unpack_array(row.keypoints)
        descriptors = unpack_array(row.descriptors)
    except Exception:  # noqa: BLE001
        logger.warning("skip corrupt ORB blob media_id=%s", row.media_id)
        return None
    return OrbFeatures(
        media_id=str(row.media_id),
        keypoints_xy=keypoints,
        descriptors=descriptors,
    )


async def _list_for_user(
    *, user_id: str, exclude_report_id: str
) -> list[CorpusOrbFeature]:
    owner = _parse_uuid(user_id)
    exclude = _parse_uuid(exclude_report_id)
    if owner is None:
        return []
    async with SessionLocal() as session:
        stmt = select(AiMediaOrbFeature).where(AiMediaOrbFeature.user_id == owner)
        if exclude is not None:
            stmt = stmt.where(AiMediaOrbFeature.report_id != exclude)
        result = await session.execute(stmt)
        hits: list[CorpusOrbFeature] = []
        for row in result.scalars().all():
            features = _features_from_row(row)
            if features is None or features.keypoint_count == 0:
                continue
            hits.append(
                CorpusOrbFeature(
                    report_id=str(row.report_id),
                    user_id=str(row.user_id) if row.user_id else None,
                    media_id=str(row.media_id),
                    features=features,
                )
            )
        return hits


async def _upsert_orb_features(
    *,
    report_id: str,
    user_id: str,
    records: Sequence[ComputedMediaHashes],
) -> None:
    report_uuid = _parse_uuid(report_id)
    user_uuid = _parse_uuid(user_id)
    if report_uuid is None:
        logger.warning("skip ORB upsert: invalid report_id=%s", report_id)
        return

    rows: list[dict] = []
    for rec in records:
        features = rec.orb
        if features is None or features.keypoint_count == 0:
            continue
        media_uuid = _parse_uuid(rec.media_id)
        file_uuid = _parse_uuid(rec.report_media_file_id)
        if media_uuid is None or file_uuid is None:
            continue
        rows.append(
            {
                "report_id": report_uuid,
                "report_media_file_id": file_uuid,
                "media_id": media_uuid,
                "user_id": user_uuid,
                "keypoints": pack_array(features.keypoints_xy),
                "descriptors": pack_array(features.descriptors),
                "keypoint_count": features.keypoint_count,
            }
        )

    if not rows:
        return

    async with SessionLocal() as session:
        stmt = insert(AiMediaOrbFeature).values(rows)
        stmt = stmt.on_conflict_do_update(
            constraint="uq_ai_media_orb_media",
            set_={
                "keypoints": stmt.excluded.keypoints,
                "descriptors": stmt.excluded.descriptors,
                "keypoint_count": stmt.excluded.keypoint_count,
                "report_id": stmt.excluded.report_id,
                "report_media_file_id": stmt.excluded.report_media_file_id,
                "user_id": stmt.excluded.user_id,
            },
        )
        await session.execute(stmt)
        await session.commit()
        logger.info(
            "upserted ORB features report_id=%s rows=%s",
            report_id,
            len(rows),
        )


async def _delete_by_media_ids(media_ids: Sequence[str]) -> int:
    uuids = [u for u in (_parse_uuid(mid) for mid in media_ids) if u is not None]
    if not uuids:
        return 0
    async with SessionLocal() as session:
        stmt = delete(AiMediaOrbFeature).where(AiMediaOrbFeature.media_id.in_(uuids))
        result = await session.execute(stmt)
        await session.commit()
        deleted = result.rowcount or 0
        logger.info(
            "deleted ORB features count=%s media_ids=%s",
            deleted,
            [str(u) for u in uuids],
        )
        return deleted


def list_for_user_sync(
    *, user_id: str, exclude_report_id: str
) -> list[CorpusOrbFeature]:
    return run_coro(
        _list_for_user(user_id=user_id, exclude_report_id=exclude_report_id)
    )


def upsert_orb_features_sync(
    *,
    report_id: str,
    user_id: str,
    records: Sequence[ComputedMediaHashes],
) -> None:
    run_coro(
        _upsert_orb_features(
            report_id=report_id, user_id=user_id, records=records
        )
    )


def delete_orb_features_by_media_ids_sync(media_ids: Sequence[str]) -> int:
    return run_coro(_delete_by_media_ids(media_ids))
