"""Cache and daily counter of the duplicate signal `internet` (specs/011 research R5).

Each call opens its own short session: images of a batch call the store concurrently and an
AsyncSession must not be shared between concurrent tasks.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional, Protocol
from zoneinfo import ZoneInfo

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert

from app.db.models import AiWebDetectionCache

logger = logging.getLogger("ai-service.verification.web_store")

QUOTA_TZ = ZoneInfo("Asia/Ho_Chi_Minh")


class WebStorePort(Protocol):
    async def get_candidates(self, phash_hex: str) -> Optional[list[dict[str, Any]]]: ...

    async def put_candidates(self, phash_hex: str, candidates: list[dict[str, Any]], ttl_days: int) -> None: ...

    async def reserve_call(self, daily_limit: int) -> bool: ...


def quota_day(now: Optional[datetime] = None) -> date:
    return (now or datetime.now(timezone.utc)).astimezone(QUOTA_TZ).date()


class SqlWebStore:
    def __init__(self, session_factory: Any = None) -> None:
        if session_factory is None:
            from app.db.session import SessionLocal  # lazy: tests build the store without a DB engine

            session_factory = SessionLocal
        self._sessions = session_factory

    async def get_candidates(self, phash_hex: str) -> Optional[list[dict[str, Any]]]:
        """Unexpired candidates, or None. Errors are logged and read as a miss."""
        try:
            async with self._sessions() as session:
                row = await session.scalar(
                    select(AiWebDetectionCache).where(
                        AiWebDetectionCache.phash == phash_hex.lower(),
                        AiWebDetectionCache.expires_at > datetime.now(timezone.utc),
                    )
                )
                return list(row.candidates) if row is not None else None
        except Exception:  # noqa: BLE001
            logger.exception("web cache read failed phash=%s", phash_hex)
            return None

    async def put_candidates(self, phash_hex: str, candidates: list[dict[str, Any]], ttl_days: int) -> None:
        now = datetime.now(timezone.utc)
        values = dict(
            phash=phash_hex.lower(),
            candidates=candidates,
            fetched_at=now,
            expires_at=now + timedelta(days=ttl_days),
        )
        try:
            async with self._sessions() as session:
                stmt = insert(AiWebDetectionCache).values(**values)
                await session.execute(
                    stmt.on_conflict_do_update(
                        index_elements=[AiWebDetectionCache.phash],
                        set_={k: stmt.excluded[k] for k in ("candidates", "fetched_at", "expires_at")},
                    )
                )
                await session.commit()
        except Exception:  # noqa: BLE001 — a lost cache write only costs a later Vision call
            logger.exception("web cache write failed phash=%s", phash_hex)

    async def reserve_call(self, daily_limit: int) -> bool:
        """Counts one Vision call for today before it is made; False when over the limit. Errors raise."""
        async with self._sessions() as session:
            calls = await session.scalar(
                text(
                    "INSERT INTO ai_web_detection_usage (day, calls) VALUES (:day, 1) "
                    "ON CONFLICT (day) DO UPDATE SET calls = ai_web_detection_usage.calls + 1 "
                    "RETURNING calls"
                ),
                {"day": quota_day()},
            )
            await session.commit()
        return int(calls) <= daily_limit
