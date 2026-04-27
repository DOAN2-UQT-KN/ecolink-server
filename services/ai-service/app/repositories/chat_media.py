"""Chat image attachments stored in ai-service (independent from incident `media`)."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AiChatMedia


async def create_chat_media_row(
    session: AsyncSession,
    user_id: uuid.UUID,
    url: str,
) -> AiChatMedia:
    row = AiChatMedia(user_id=user_id, url=url.strip())
    session.add(row)
    await session.flush()
    await session.refresh(row)
    return row


async def list_chat_media_for_user_ids(
    session: AsyncSession,
    user_id: uuid.UUID,
    ids: list[uuid.UUID],
) -> list[AiChatMedia]:
    if not ids:
        return []
    res = await session.execute(
        select(AiChatMedia).where(
            AiChatMedia.user_id == user_id,
            AiChatMedia.id.in_(ids),
        )
    )
    rows = list(res.scalars().all())
    by_id = {r.id: r for r in rows}
    return [by_id[i] for i in ids if i in by_id]


async def fetch_url_map_for_user(
    session: AsyncSession,
    user_id: uuid.UUID,
    media_id_strings: list[str],
) -> dict[str, str]:
    uuids: list[uuid.UUID] = []
    for s in media_id_strings:
        try:
            uuids.append(uuid.UUID(str(s).strip()))
        except ValueError:
            continue
    if not uuids:
        return {}
    rows = await list_chat_media_for_user_ids(session, user_id, uuids)
    return {str(r.id): r.url for r in rows if r.url.startswith("http")}
