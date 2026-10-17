"""Corpus queries for DuplicateCheck. Async on the request's session; never uses run_coro (research R5)."""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Protocol, Sequence

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AiMediaContentHash, AiMediaOrbFeature
from app.verification.duplicate.orb import OrbFeatures, pack_array, unpack_array
from app.verification.duplicate_check.geo import haversine_m
from app.verification.hash_compute import ALG_PHASH, phash_hex_to_int

METRES_PER_DEGREE_LAT = 111_320


@dataclass
class PhashHit:
    report_id: str
    user_id: Optional[str]
    media_id: str
    distance: int
    flipped: bool
    latitude: Optional[float]
    longitude: Optional[float]
    report_created_at: Optional[datetime]


@dataclass
class PhashCandidate:
    report_id: str
    user_id: Optional[str]
    media_id: str
    phash_int: int
    latitude: Optional[float]
    longitude: Optional[float]
    report_created_at: Optional[datetime]


@dataclass
class OrbCandidate:
    report_id: str
    user_id: Optional[str]
    media_id: str
    features: OrbFeatures
    latitude: Optional[float]
    longitude: Optional[float]
    report_created_at: Optional[datetime]


@dataclass
class CorpusImage:
    """A non-matching image of the new report, added so later reports are compared against it."""

    media_id: str
    report_media_file_id: str
    phash_hex: str
    orb: Optional[OrbFeatures]


@dataclass
class CorpusReport:
    report_id: str
    user_id: Optional[str]
    latitude: Optional[float]
    longitude: Optional[float]
    created_at: datetime
    category: str


class CorpusPort(Protocol):
    async def find_global_phash(
        self, *, q: int, q_flip: int, max_distance: int, exclude_report_id: str, limit: int = 20
    ) -> list[PhashHit]: ...

    async def list_phash_candidates(
        self, *, lat: float, lng: float, radius_m: float, since: datetime, exclude_report_id: str
    ) -> list[PhashCandidate]: ...

    async def list_orb_candidates(
        self, *, lat: float, lng: float, radius_m: float, since: datetime, exclude_report_id: str
    ) -> list[OrbCandidate]: ...

    async def upsert(self, *, report: CorpusReport, images: Sequence[CorpusImage]) -> None: ...


def _uuid(value: Optional[str]) -> Optional[uuid.UUID]:
    try:
        return uuid.UUID(value) if value else None
    except (ValueError, TypeError, AttributeError):
        return None


def _bounding_box(lat: float, lng: float, radius_m: float) -> tuple[float, float, float, float]:
    dlat = radius_m / METRES_PER_DEGREE_LAT
    dlng = radius_m / (METRES_PER_DEGREE_LAT * max(math.cos(math.radians(lat)), 1e-6))
    return lat - dlat, lat + dlat, lng - dlng, lng + dlng


def _within(lat: float, lng: float, radius_m: float, row_lat: Optional[float], row_lng: Optional[float]) -> bool:
    return row_lat is not None and row_lng is not None and haversine_m(lat, lng, row_lat, row_lng) <= radius_m


_GLOBAL_PHASH_SQL = text(
    """
    SELECT report_id, user_id, media_id, latitude, longitude, report_created_at, d, d_flip
    FROM (
        SELECT report_id, user_id, media_id, latitude, longitude, report_created_at,
               bit_count((phash_int # :q)::bit(64))      AS d,
               bit_count((phash_int # :q_flip)::bit(64)) AS d_flip
        FROM ai_media_content_hashes
        WHERE algorithm = 'PHASH' AND phash_int IS NOT NULL AND report_id <> :rid
    ) scored
    WHERE LEAST(d, d_flip) <= :max
    ORDER BY LEAST(d, d_flip)
    LIMIT :limit
    """
)


class SqlCorpus:
    """CorpusPort over aidb (ai_media_content_hashes / ai_media_orb_features)."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def find_global_phash(
        self, *, q: int, q_flip: int, max_distance: int, exclude_report_id: str, limit: int = 20
    ) -> list[PhashHit]:
        rid = _uuid(exclude_report_id) or uuid.UUID(int=0)
        rows = await self.session.execute(
            _GLOBAL_PHASH_SQL,
            {"q": q, "q_flip": q_flip, "rid": rid, "max": max_distance, "limit": limit},
        )
        return [
            PhashHit(
                report_id=str(r.report_id),
                user_id=str(r.user_id) if r.user_id else None,
                media_id=str(r.media_id),
                distance=min(r.d, r.d_flip),
                flipped=r.d_flip < r.d,
                latitude=r.latitude,
                longitude=r.longitude,
                report_created_at=r.report_created_at,
            )
            for r in rows
        ]

    async def list_phash_candidates(
        self, *, lat: float, lng: float, radius_m: float, since: datetime, exclude_report_id: str
    ) -> list[PhashCandidate]:
        lat_min, lat_max, lng_min, lng_max = _bounding_box(lat, lng, radius_m)
        stmt = select(AiMediaContentHash).where(
            AiMediaContentHash.algorithm == ALG_PHASH,
            AiMediaContentHash.phash_int.is_not(None),
            AiMediaContentHash.latitude.between(lat_min, lat_max),
            AiMediaContentHash.longitude.between(lng_min, lng_max),
            AiMediaContentHash.report_created_at >= since,
        )
        rid = _uuid(exclude_report_id)
        if rid is not None:
            stmt = stmt.where(AiMediaContentHash.report_id != rid)
        rows = (await self.session.execute(stmt)).scalars().all()
        return [
            PhashCandidate(
                report_id=str(r.report_id),
                user_id=str(r.user_id) if r.user_id else None,
                media_id=str(r.media_id),
                phash_int=r.phash_int,
                latitude=r.latitude,
                longitude=r.longitude,
                report_created_at=r.report_created_at,
            )
            for r in rows
            if _within(lat, lng, radius_m, r.latitude, r.longitude)
        ]

    async def list_orb_candidates(
        self, *, lat: float, lng: float, radius_m: float, since: datetime, exclude_report_id: str
    ) -> list[OrbCandidate]:
        lat_min, lat_max, lng_min, lng_max = _bounding_box(lat, lng, radius_m)
        stmt = select(AiMediaOrbFeature).where(
            AiMediaOrbFeature.latitude.between(lat_min, lat_max),
            AiMediaOrbFeature.longitude.between(lng_min, lng_max),
            AiMediaOrbFeature.report_created_at >= since,
        )
        rid = _uuid(exclude_report_id)
        if rid is not None:
            stmt = stmt.where(AiMediaOrbFeature.report_id != rid)
        out: list[OrbCandidate] = []
        for r in (await self.session.execute(stmt)).scalars().all():
            if not _within(lat, lng, radius_m, r.latitude, r.longitude):
                continue
            # Blobs are only unpacked for rows that passed the geo/time filter.
            try:
                features = OrbFeatures(
                    media_id=str(r.media_id),
                    keypoints_xy=unpack_array(r.keypoints),
                    descriptors=unpack_array(r.descriptors),
                )
            except Exception:  # noqa: BLE001 — skip a corrupt blob, keep the rest
                continue
            out.append(
                OrbCandidate(
                    report_id=str(r.report_id),
                    user_id=str(r.user_id) if r.user_id else None,
                    media_id=str(r.media_id),
                    features=features,
                    latitude=r.latitude,
                    longitude=r.longitude,
                    report_created_at=r.report_created_at,
                )
            )
        return out

    async def upsert(self, *, report: CorpusReport, images: Sequence[CorpusImage]) -> None:
        report_uuid = _uuid(report.report_id)
        if report_uuid is None or not images:
            return
        geo = {
            "latitude": report.latitude,
            "longitude": report.longitude,
            "report_created_at": report.created_at,
        }
        hash_rows: list[dict] = []
        orb_rows: list[dict] = []
        for img in images:
            media_uuid, file_uuid = _uuid(img.media_id), _uuid(img.report_media_file_id)
            if media_uuid is None or file_uuid is None:
                continue
            base = {
                "report_id": report_uuid,
                "report_media_file_id": file_uuid,
                "media_id": media_uuid,
                "user_id": _uuid(report.user_id),
                **geo,
            }
            hash_rows.append(
                {
                    **base,
                    "algorithm": ALG_PHASH,
                    "hash": img.phash_hex,
                    "phash_int": phash_hex_to_int(img.phash_hex),
                    "category": report.category,
                }
            )
            if img.orb is not None and img.orb.keypoint_count:
                orb_rows.append(
                    {
                        **base,
                        "keypoints": pack_array(img.orb.keypoints_xy),
                        "descriptors": pack_array(img.orb.descriptors),
                        "keypoint_count": img.orb.keypoint_count,
                    }
                )

        if hash_rows:
            stmt = insert(AiMediaContentHash).values(hash_rows)
            excluded = stmt.excluded
            await self.session.execute(
                stmt.on_conflict_do_update(
                    constraint="uq_ai_media_hash_media_algo",
                    set_={
                        k: getattr(excluded, k)
                        for k in ("hash", "phash_int", "report_id", "report_media_file_id", "user_id",
                                  "latitude", "longitude", "report_created_at", "category")
                    },
                )
            )
        if orb_rows:
            stmt = insert(AiMediaOrbFeature).values(orb_rows)
            excluded = stmt.excluded
            await self.session.execute(
                stmt.on_conflict_do_update(
                    constraint="uq_ai_media_orb_media",
                    set_={
                        k: getattr(excluded, k)
                        for k in ("keypoints", "descriptors", "keypoint_count", "report_id",
                                  "report_media_file_id", "user_id", "latitude", "longitude",
                                  "report_created_at")
                    },
                )
            )
        await self.session.commit()
