"""HTTP tools for report media (incident-service)."""

from __future__ import annotations

import json
import re
from typing import Any

from app.tools.definitions import RegisteredTool, ToolContext
from app.tools.incident_client import incident_request_json

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_MAX_IDS = 100


async def _list_report_media_files_by_ids(
    args: dict[str, Any], ctx: ToolContext
) -> str:
    raw = args.get("media_file_ids")
    if not isinstance(raw, list) or len(raw) == 0:
        return json.dumps(
            {"error": "media_file_ids must be a non-empty array of UUID strings"}
        )
    ids: list[str] = []
    seen: set[str] = set()
    for x in raw:
        if not isinstance(x, str):
            return json.dumps({"error": "Each media_file_ids entry must be a string UUID"})
        s = x.strip()
        if not _UUID_RE.match(s):
            return json.dumps({"error": f"Invalid UUID: {s!r}"})
        if s not in seen:
            seen.add(s)
            ids.append(s)
    if len(ids) > _MAX_IDS:
        return json.dumps({"error": f"At most {_MAX_IDS} ids allowed"})

    params: list[tuple[str, str]] = [("mediaFileIds", i) for i in ids]
    return await incident_request_json(
        "GET",
        "/api/v1/reports/media-files/by-ids",
        ctx,
        params=params,
    )


list_report_media_files_by_ids_tool = RegisteredTool(
    name="list_report_media_files_by_ids",
    description=(
        "Loads report media file records by their UUID ids (report_media_files.id). "
        "Returns url and type for each visible row (you must own the parent report or the report must be verified). "
        "Max 100 ids; order in the response follows the request order for ids that exist and are visible."
    ),
    parameters={
        "type": "object",
        "properties": {
            "media_file_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "UUIDs of report_media_files rows",
                "minItems": 1,
                "maxItems": 100,
            },
        },
        "required": ["media_file_ids"],
    },
    handler=_list_report_media_files_by_ids,
)
