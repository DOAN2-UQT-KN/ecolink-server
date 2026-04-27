import re
import uuid
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import AuthContext, get_auth_context, get_current_user_id
from app.chat.service import stream_chat_turn
from app.db.models import ChatMessageRole
from app.db.session import SessionLocal, get_session
from app.repositories.chat import ChatRepository
from app.repositories.chat_media import create_chat_media_row
from app.repositories.deps import get_chat_repository
from app.tools.registry import REGISTERED_AGENT_IDS, tool_catalog

router = APIRouter(tags=["chat"])

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_MAX_CHAT_MEDIA = 10


class CreateConversationBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    agent_id: str = Field(alias="agentId")
    title: Optional[str] = None


class RegisterChatMediaBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    image_url: str = Field(alias="imageUrl")

    @field_validator("image_url")
    @classmethod
    def must_be_http_url(cls, v: str) -> str:
        s = (v or "").strip()
        if not s.startswith(("https://", "http://")):
            raise ValueError("imageUrl must be an http(s) URL")
        if len(s) > 4096:
            raise ValueError("imageUrl is too long")
        return s


class StreamBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    content: str = ""
    media_ids: list[str] = Field(default_factory=list, alias="mediaIds")

    @field_validator("content")
    @classmethod
    def strip_content(cls, v: str) -> str:
        return (v or "").strip()

    @field_validator("media_ids", mode="before")
    @classmethod
    def coerce_media_ids(cls, v: object) -> list[str]:
        if v is None:
            return []
        if not isinstance(v, list):
            return []
        return [str(x).strip() for x in v if str(x).strip()]

    @field_validator("media_ids")
    @classmethod
    def validate_media_ids(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        for s in v[:_MAX_CHAT_MEDIA]:
            if not _UUID_RE.match(s):
                raise ValueError(f"Invalid mediaId UUID: {s!r}")
            if s not in seen:
                seen.add(s)
                out.append(s)
        return out


@router.get("/agents")
async def list_agents_and_tools() -> dict:
    return {"agents": tool_catalog()}


@router.post("/media")
async def register_chat_media(
    body: RegisterChatMediaBody,
    user_id: Annotated[str, Depends(get_current_user_id)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    """Register a hosted image URL as `ai_chat_media` (e.g. after Cloudinary upload from the client)."""
    row = await create_chat_media_row(session, uuid.UUID(user_id), body.image_url)
    await session.commit()
    return {
        "media": {
            "id": str(row.id),
            "url": row.url,
            "type": "chat_image",
            "created_at": row.created_at.isoformat() if row.created_at else None,
        }
    }


@router.post("/conversations")
async def create_conversation(
    body: CreateConversationBody,
    user_id: Annotated[str, Depends(get_current_user_id)],
    repo: Annotated[ChatRepository, Depends(get_chat_repository)],
) -> dict:
    if body.agent_id not in REGISTERED_AGENT_IDS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown agentId; allowed: {list(REGISTERED_AGENT_IDS)}",
        )
    conv = await repo.create_conversation(
        uuid.UUID(user_id),
        body.agent_id,
        body.title,
    )
    return {
        "conversation": {
            "id": str(conv.id),
            "agent_id": conv.agent_id,
            "title": conv.title,
            "created_at": conv.created_at.isoformat() if conv.created_at else None,
        }
    }


@router.get("/conversations/{conversation_id}/messages")
async def list_messages(
    conversation_id: uuid.UUID,
    user_id: Annotated[str, Depends(get_current_user_id)],
    repo: Annotated[ChatRepository, Depends(get_chat_repository)],
) -> dict:
    rows = await repo.list_messages_for_user(conversation_id, uuid.UUID(user_id))
    if rows is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    return {
        "messages": [
            {
                "id": str(m.id),
                "role": m.role.value,
                "content": m.content,
                "append_text": m.append_text,
                "tool_calls": m.tool_calls,
                "tool_call_id": m.tool_call_id,
                "created_at": m.created_at.isoformat() if m.created_at else None,
            }
            for m in rows
            if m.role != ChatMessageRole.system
        ]
    }


@router.post("/conversations/{conversation_id}/messages/stream")
async def stream_message(
    conversation_id: uuid.UUID,
    body: StreamBody,
    auth: Annotated[AuthContext, Depends(get_auth_context)],
) -> StreamingResponse:
    text = body.content
    media_ids = body.media_ids
    if not text and not media_ids:
        raise HTTPException(
            status_code=400,
            detail="Either content or mediaIds (non-empty) is required",
        )

    uid = uuid.UUID(auth.user_id)
    token = auth.access_token

    async def gen():
        async with SessionLocal() as stream_session:
            repo = ChatRepository(stream_session)
            async for chunk in stream_chat_turn(
                repo,
                uid,
                conversation_id,
                text,
                token,
                media_ids if media_ids else None,
            ):
                yield chunk

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
