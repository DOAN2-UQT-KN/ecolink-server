"""Agent-side attachment context in `append_text` (+ legacy embed in `content`)."""

from __future__ import annotations

import re
from typing import Optional

_MEDIA_IDS_MARKER = "\n\nmedia_ids:\n"
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def format_append_text_for_media_ids(media_ids: Optional[list[str]]) -> str:
    """Store image ids for the agent (persisted on `ChatMessage.append_text`)."""
    ids = [x.strip() for x in (media_ids or []) if isinstance(x, str) and x.strip()]
    if not ids:
        return ""
    return "media_ids:\n" + "\n".join(ids) + "\n"


def parse_media_ids_from_append_text(append: Optional[str]) -> list[str]:
    if not append or not str(append).strip():
        return []
    lines = [ln.rstrip() for ln in str(append).strip().splitlines()]
    if not lines:
        return []
    start = 0
    if lines[0].strip().lower() == "media_ids:":
        start = 1
    mids: list[str] = []
    for line in lines[start:]:
        s = line.strip()
        if s and _UUID_RE.match(s):
            mids.append(s)
    return mids


def parse_user_message_media_ids(content: Optional[str]) -> tuple[str, list[str]]:
    """Legacy: split user text and trailing `media_ids:` block embedded in `content`."""
    if not content:
        return "", []
    c = content
    if _MEDIA_IDS_MARKER not in c:
        return c.rstrip(), []
    body, _, rest = c.rpartition(_MEDIA_IDS_MARKER)
    body = body.rstrip()
    mids: list[str] = []
    for line in rest.splitlines():
        s = line.strip()
        if s and _UUID_RE.match(s):
            mids.append(s)
    return body, mids
