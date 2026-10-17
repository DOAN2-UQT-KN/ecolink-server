"""One-off corpus backfill for DuplicateCheck (specs/006 P06).

Run once per environment before turning REPORT_VERIFICATION_ENABLED on:
    python -m scripts.backfill_corpus [--dry-run]

1. phash_int from the hex hash (same statement as migration 001, safe to re-run).
2. latitude / longitude / report_created_at (and category) from incident-service
   POST /internal/v1/reports/geo-by-ids, 500 reports per call.
"""

from __future__ import annotations

import argparse
import asyncio
import uuid
from datetime import datetime

import httpx
from sqlalchemy import text

from app.config import settings
from app.db.session import engine

BATCH = 500

PHASH_INT_SQL = """
UPDATE ai_media_content_hashes
SET phash_int = ('x' || lpad(hash, 16, '0'))::bit(64)::bigint
WHERE algorithm = 'PHASH' AND phash_int IS NULL AND hash ~ '^[0-9a-fA-F]{16}$'
"""

MISSING_GEO_SQL = """
SELECT DISTINCT report_id FROM ai_media_content_hashes WHERE latitude IS NULL
UNION
SELECT DISTINCT report_id FROM ai_media_orb_features WHERE latitude IS NULL
"""


def fetch_geo(ids: list[str]) -> list[dict]:
    key = (settings.internal_ai_api_key or "").strip()
    if not key:
        raise RuntimeError("INTERNAL_AI_API_KEY is not configured")
    url = f"{settings.incident_api_base_url.rstrip('/')}/internal/v1/reports/geo-by-ids"
    response = httpx.post(url, json={"ids": ids}, headers={"x-internal-api-key": key}, timeout=30)
    response.raise_for_status()
    return response.json()["data"]["reports"]


async def main(dry_run: bool) -> None:
    async with engine.begin() as conn:
        if dry_run:
            pending = (await conn.execute(text(
                "SELECT count(*) FROM ai_media_content_hashes WHERE algorithm='PHASH' AND phash_int IS NULL"
            ))).scalar_one()
            print(f"phash_int missing: {pending}")
        else:
            print(f"phash_int updated: {(await conn.execute(text(PHASH_INT_SQL))).rowcount}")

        report_ids = [str(r[0]) for r in (await conn.execute(text(MISSING_GEO_SQL))).all()]
        print(f"reports without geo: {len(report_ids)}")
        hashes = orbs = 0
        for start in range(0, len(report_ids), BATCH):
            for row in await asyncio.to_thread(fetch_geo, report_ids[start : start + BATCH]):
                params = {
                    "rid": uuid.UUID(row["id"]),
                    "lat": row.get("latitude"),
                    "lng": row.get("longitude"),
                    "created": datetime.fromisoformat(row["created_at"].replace("Z", "+00:00")),
                    "category": row.get("category"),
                }
                if dry_run:
                    continue
                hashes += (await conn.execute(text(
                    "UPDATE ai_media_content_hashes SET latitude=:lat, longitude=:lng, "
                    "report_created_at=:created, category=:category WHERE report_id=:rid"
                ), params)).rowcount
                orbs += (await conn.execute(text(
                    "UPDATE ai_media_orb_features SET latitude=:lat, longitude=:lng, "
                    "report_created_at=:created WHERE report_id=:rid"
                ), params)).rowcount
        print(f"geo updated: ai_media_content_hashes={hashes} ai_media_orb_features={orbs}"
              + (" (dry run, nothing written)" if dry_run else ""))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    asyncio.run(main(parser.parse_args().dry_run))
