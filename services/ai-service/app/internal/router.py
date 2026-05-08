import logging
import traceback

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import require_internal_api_key
from app.chat.service import translate_text

logger = logging.getLogger(__name__)

router = APIRouter(tags=["internal"])


class InternalTranslateBody(BaseModel):
    content: str


@router.post(
    "/translate",
    dependencies=[Depends(require_internal_api_key)],
)
async def internal_translate(body: InternalTranslateBody) -> dict:
    """
    Service-to-service translation. Same response shape as
    `POST /api/v1/chat/translate` but authenticated via the shared
    `x-internal-api-key` header instead of a per-user JWT, so background
    workers (incident-translation / reward-translation queues) can use it.
    """
    if body.content == "":
        raise HTTPException(status_code=400, detail="content is required")
    try:
        return await translate_text(body.content)
    except RuntimeError as e:
        # Most likely path: translate_text raised a known validation failure
        # (bad JSON, bad detected_language, missing OPENAI_API_KEY, ...).
        logger.warning(
            "[internal/translate] RuntimeError for content=%r: %s",
            body.content[:200],
            e,
        )
        raise HTTPException(status_code=500, detail=str(e)) from e
    except Exception as e:
        # Unexpected (openai client error, network, etc). Log full traceback
        # so workers don't silently fall back to source text without us
        # knowing the upstream cause.
        logger.error(
            "[internal/translate] unexpected error for content=%r:\n%s",
            body.content[:200],
            traceback.format_exc(),
        )
        raise HTTPException(
            status_code=500,
            detail=f"{type(e).__name__}: {e}",
        ) from e
