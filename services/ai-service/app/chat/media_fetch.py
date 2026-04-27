"""Resolve chat attachment ids → public image URLs from ai-service `ai_chat_media`."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.chat_media import fetch_url_map_for_user


async def fetch_chat_media_url_map(
    session: AsyncSession,
    user_id: uuid.UUID,
    media_ids: list[str],
) -> dict[str, str]:
    if not media_ids:
        return {}
    return await fetch_url_map_for_user(session, user_id, media_ids)
