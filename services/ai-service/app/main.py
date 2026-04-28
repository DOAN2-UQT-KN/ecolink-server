from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import logging

from app.chat.router import router as chat_router
from app.recommendation.router import router as recommendation_router
from app.config import settings
from app.db.session import init_db


logger = logging.getLogger("ai-service")


def _mask_db_url(url: str) -> str:
    # Avoid leaking credentials in logs.
    try:
        from urllib.parse import urlparse, urlunparse

        parsed = urlparse(url)
        if parsed.username or parsed.password:
            netloc = parsed.hostname or ""
            if parsed.port:
                netloc += f":{parsed.port}"
            if parsed.username:
                netloc = f"{parsed.username}:***@" + netloc
            return urlunparse(parsed._replace(netloc=netloc))
        return url
    except Exception:
        return "<unparseable DATABASE_URL>"


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    logger.info(
        "Starting ai-service with DATABASE_URL=%s (auto_create_db_tables=%s)",
        _mask_db_url(settings.database_url),
        settings.auto_create_db_tables,
    )
    try:
        await init_db()
    except Exception:
        # Keep API up so /health and other endpoints can be inspected even if DB isn't ready.
        logger.exception("Database init failed; continuing without DB initialization.")
    yield


app = FastAPI(title="EcoLink AI service", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.cors_origin] if settings.cors_origin != "*" else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "ai-service"}


app.include_router(chat_router, prefix="/api/v1/chat")
app.include_router(recommendation_router, prefix="/api/v1/recommendations")
