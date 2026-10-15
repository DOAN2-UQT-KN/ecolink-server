"""SqlCorpus + migrations against a real Postgres (>= 14 for bit_count). Skipped without TEST_DATABASE_URL.

    docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=x postgis/postgis:16-3.4
    TEST_DATABASE_URL=postgresql+asyncpg://postgres:x@localhost:55433/postgres python -m pytest tests/test_duplicate_check_corpus_db.py
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.migrations import run_migrations
from app.db.models import Base
from app.verification.duplicate.orb import OrbFeatures
from app.verification.duplicate_check.corpus import CorpusImage, CorpusReport, SqlCorpus
from app.verification.hash_compute import phash_hex_to_int

URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL not set")

NOW = datetime(2026, 10, 16, 8, 0, tzinfo=timezone.utc)
Q_HEX = "00000000000000ff"


def flip_bits(hex_str: str, n: int) -> str:
    return f"{int(hex_str, 16) ^ ((1 << n) - 1) << 20:016x}"


async def _setup():
    engine = create_async_engine(URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
        await run_migrations(conn)
        await run_migrations(conn)  # idempotent
    return engine


async def _insert_hash(conn, hex_str: str, *, lat=10.79, lng=106.68, created=NOW, algorithm="PHASH", phash_int=True):
    await conn.execute(
        text(
            "INSERT INTO ai_media_content_hashes (id, report_id, report_media_file_id, media_id, algorithm, hash, "
            "phash_int, latitude, longitude, report_created_at) "
            "VALUES (:id, :rid, :fid, :mid, :alg, :hash, :pint, :lat, :lng, :created)"
        ),
        {
            "id": uuid.uuid4(), "rid": uuid.uuid4(), "fid": uuid.uuid4(), "mid": uuid.uuid4(),
            "alg": algorithm, "hash": hex_str,
            "pint": phash_hex_to_int(hex_str) if phash_int and algorithm == "PHASH" else None,
            "lat": lat, "lng": lng, "created": created,
        },
    )


def test_global_phash_search_candidates_and_upsert() -> None:
    async def scenario() -> None:
        engine = await _setup()
        async with engine.begin() as conn:
            await _insert_hash(conn, flip_bits(Q_HEX, 4))                 # 4 bits away
            await _insert_hash(conn, flip_bits(Q_HEX, 8))                 # 8 bits away
            await _insert_hash(conn, "ffffffffffffff00")                  # negative bigint, 64 bits away
            await _insert_hash(conn, "8000000000000000", lat=10.80)       # ~1.1 km north
            await _insert_hash(conn, "7000000000000000", created=NOW - timedelta(days=30))

        session = async_sessionmaker(engine, expire_on_commit=False)()
        corpus = SqlCorpus(session)
        q = phash_hex_to_int(Q_HEX)
        other = uuid.uuid4().hex

        hits = await corpus.find_global_phash(q=q, q_flip=q, max_distance=6, exclude_report_id=other)
        assert [h.distance for h in hits] == [4]

        flipped_q = phash_hex_to_int(flip_bits(Q_HEX, 4))
        via_flip = await corpus.find_global_phash(q=phash_hex_to_int("ffffffffffff0000"), q_flip=flipped_q,
                                                  max_distance=6, exclude_report_id=other)
        assert via_flip and via_flip[0].distance == 0 and via_flip[0].flipped is True

        neg_q = phash_hex_to_int("ffffffffffffff01")
        negative = await corpus.find_global_phash(q=neg_q, q_flip=neg_q,
                                                  max_distance=1, exclude_report_id=other)
        assert [h.distance for h in negative] == [1]

        cands = await corpus.list_phash_candidates(lat=10.79, lng=106.68, radius_m=500,
                                                   since=NOW - timedelta(days=7), exclude_report_id=other)
        assert len(cands) == 3  # the 1.1 km row and the 30-day-old row are filtered out

        report_id = str(uuid.uuid4())
        await corpus.upsert(
            report=CorpusReport(report_id, None, 10.79, 106.68, NOW, "MARKET"),
            images=[CorpusImage(str(uuid.uuid4()), str(uuid.uuid4()), "ffffffffffffffff",
                                OrbFeatures("m", np.zeros((3, 2), np.float32), np.zeros((3, 32), np.uint8)))],
        )
        async with engine.connect() as conn:
            row = (await conn.execute(text(
                "SELECT phash_int, category FROM ai_media_content_hashes WHERE report_id = :r"
            ), {"r": uuid.UUID(report_id)})).one()
            assert row.phash_int == -1 and row.category == "MARKET"
            orb = (await conn.execute(text(
                "SELECT keypoint_count, latitude FROM ai_media_orb_features WHERE report_id = :r"
            ), {"r": uuid.UUID(report_id)})).one()
            assert orb.keypoint_count == 3 and orb.latitude == 10.79
        await session.close()
        await engine.dispose()

    asyncio.run(scenario())


def test_migration_drops_sha256_and_backfills_phash_int() -> None:
    async def scenario() -> None:
        engine = await _setup()
        async with engine.begin() as conn:
            await _insert_hash(conn, "a" * 64, algorithm="SHA256")
            await _insert_hash(conn, "ffffffffffffffff", phash_int=False)
            await run_migrations(conn)
            rows = (await conn.execute(text("SELECT algorithm, phash_int FROM ai_media_content_hashes"))).all()
        assert [(r.algorithm, r.phash_int) for r in rows] == [("PHASH", -1)]
        await engine.dispose()

    asyncio.run(scenario())
