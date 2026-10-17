"""SqlWebStore (specs/011) against a real Postgres. Skipped without TEST_DATABASE_URL (see test_duplicate_check_corpus_db.py)."""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.migrations import run_migrations
from app.db.models import Base
from app.verification.duplicate_check.web_store import SqlWebStore, quota_day

URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL not set")

CANDS = [{"image_url": "https://a.example/1.jpg", "page_url": None, "page_title": None, "match_type": "FULL"}]


async def _store() -> tuple[SqlWebStore, object]:
    engine = create_async_engine(URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
        await run_migrations(conn)
        await run_migrations(conn)  # idempotent
    return SqlWebStore(async_sessionmaker(engine, expire_on_commit=False)), engine


def test_reserve_call_counts_and_stops_at_the_limit() -> None:
    async def scenario():
        store, engine = await _store()
        got = [await store.reserve_call(2) for _ in range(3)]
        assert await asyncio.gather(*(store.reserve_call(100) for _ in range(5)))  # concurrent increments
        async with engine.connect() as conn:
            calls = await conn.scalar(text("SELECT calls FROM ai_web_detection_usage WHERE day = :d"), {"d": quota_day()})
        await engine.dispose()
        return got, calls

    got, calls = asyncio.run(scenario())
    assert got == [True, True, False]
    assert calls == 8


def test_cache_put_get_overwrite_and_expiry() -> None:
    async def scenario():
        store, engine = await _store()
        assert await store.get_candidates("ABCDEF0123456789") is None
        await store.put_candidates("ABCDEF0123456789", CANDS, 30)
        first = await store.get_candidates("abcdef0123456789")
        await store.put_candidates("abcdef0123456789", [], 30)
        second = await store.get_candidates("abcdef0123456789")
        async with engine.begin() as conn:
            await conn.execute(
                text("UPDATE ai_web_detection_cache SET expires_at = :t"),
                {"t": datetime.now(timezone.utc) - timedelta(seconds=1)},
            )
        expired = await store.get_candidates("abcdef0123456789")
        await engine.dispose()
        return first, second, expired

    first, second, expired = asyncio.run(scenario())
    assert first == CANDS and second == [] and expired is None


def test_quota_day_uses_vietnam_time() -> None:
    late_utc = datetime(2026, 10, 16, 18, 30, tzinfo=timezone.utc)  # 01:30 on the 17th in UTC+7
    assert quota_day(late_utc).isoformat() == "2026-10-17"
