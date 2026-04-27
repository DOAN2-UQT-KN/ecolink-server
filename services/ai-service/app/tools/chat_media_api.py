"""Tools for EcoLink assistant chat images (ai-service `ai_chat_media` table)."""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from app.repositories.chat import ChatRepository
from app.repositories.chat_media import list_chat_media_for_user_ids
from app.tools.definitions import RegisteredTool, ToolContext

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_MAX_IDS = 50


async def _list_chat_media_by_ids(args: dict[str, Any], ctx: ToolContext) -> str:
    raw = args.get("media_ids")
    if not isinstance(raw, list) or len(raw) == 0:
        return json.dumps(
            {"error": "media_ids must be a non-empty array of UUID strings"}
        )
    ids: list[uuid.UUID] = []
    seen: set[str] = set()
    for x in raw:
        if not isinstance(x, str):
            return json.dumps({"error": "Each media_ids entry must be a string UUID"})
        s = x.strip()
        if not _UUID_RE.match(s):
            return json.dumps({"error": f"Invalid UUID: {s!r}"})
        if s not in seen:
            seen.add(s)
            try:
                ids.append(uuid.UUID(s))
            except ValueError:
                return json.dumps({"error": f"Invalid UUID: {s!r}"})
    if len(ids) > _MAX_IDS:
        return json.dumps({"error": f"At most {_MAX_IDS} ids allowed"})

    repo = ctx.get("chat_repo")
    user_raw = ctx.get("user_id")
    if not isinstance(repo, ChatRepository) or not isinstance(user_raw, str):
        return json.dumps({"error": "Missing chat context"})

    try:
        uid = uuid.UUID(user_raw)
    except ValueError:
        return json.dumps({"error": "Invalid user in context"})

    rows = await list_chat_media_for_user_ids(repo.session, uid, ids)
    media = [
        {
            "id": str(r.id),
            "url": r.url,
            "type": "chat_image",
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]
    return json.dumps({"media": media}, default=str)


list_chat_media_by_ids_tool = RegisteredTool(
    name="list_chat_media_by_ids",
    description=(
        "Returns metadata for images the user attached in EcoLink assistant chat: each row has "
        "media_id (`id`), public `url`, and `type` (chat_image). Only rows owned by the signed-in "
        "user are returned. Use when the user lists media_id values on their message or you need "
        "URLs before describing image content."
    ),
    parameters={
        "type": "object",
        "properties": {
            "media_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "UUID values of `ai_chat_media.id` from the user's chat attachments",
                "minItems": 1,
                "maxItems": 50,
            },
        },
        "required": ["media_ids"],
    },
    handler=_list_chat_media_by_ids,
)
