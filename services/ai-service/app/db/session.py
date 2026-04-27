from collections.abc import AsyncGenerator
from urllib.parse import urlparse, urlunparse

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import settings
from app.db.models import Base


def _to_asyncpg_url(url: str) -> str:
    """postgresql:// → postgresql+asyncpg://"""
    if url.startswith("postgresql+asyncpg://"):
        return url
    if url.startswith("postgres://"):
        return "postgresql+asyncpg://" + url[len("postgres://") :]
    if url.startswith("postgresql://"):
        return "postgresql+asyncpg://" + url[len("postgresql://") :]
    return url


def _asyncpg_safe_query(url: str) -> str:
    """Strip query keys asyncpg does not accept (libpq / Prisma-style extras)."""
    parsed = urlparse(url)
    if not parsed.hostname:
        raise ValueError(
            "DATABASE_URL has no hostname (check for stray quotes, spaces, or @@ in the URL).",
        )
    if not parsed.query:
        return url
    drop_prefixes = ("sslmode=", "schema=")
    parts = [
        p
        for p in parsed.query.split("&")
        if p and not any(p.startswith(pref) for pref in drop_prefixes)
    ]
    new_query = "&".join(parts)
    return urlunparse(parsed._replace(query=new_query))


engine = create_async_engine(
    _asyncpg_safe_query(_to_asyncpg_url(settings.database_url)),
    echo=False,
)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session


async def init_db() -> None:
    if not settings.auto_create_db_tables:
        return
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
