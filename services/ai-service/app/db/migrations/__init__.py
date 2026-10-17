"""Plain-SQL migrations applied by init_db() after create_all (specs/006 research R4)."""

from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncConnection

logger = logging.getLogger("ai-service.db.migrations")

_DIR = Path(__file__).parent


def _statements(sql: str) -> list[str]:
    lines = [line for line in sql.splitlines() if not line.strip().startswith("--")]
    return [stmt.strip() for stmt in "\n".join(lines).split(";") if stmt.strip()]


# shortcut: no version table, every file must be idempotent; move to Alembic at the 3rd migration.
async def run_migrations(conn: AsyncConnection) -> None:
    for path in sorted(_DIR.glob("*.sql")):
        for stmt in _statements(path.read_text(encoding="utf-8")):
            await conn.exec_driver_sql(stmt)
        logger.info("applied migration %s", path.name)
