"""HTTP tools against incident-service organization APIs (user JWT forwarded)."""

from __future__ import annotations

import json
import uuid
from typing import Any, Optional

from app.repositories.chat import ChatRepository
from app.repositories.chat_media import list_chat_media_for_user_ids
from app.tools.definitions import RegisteredTool, ToolContext
from app.tools.incident_client import incident_request_json

_DEFAULT_LOGO_URL = "https://placehold.co/256x256/png?text=EcoLink"


async def _create_organization(args: dict[str, Any], ctx: ToolContext) -> str:
    name = (args.get("name") or "").strip()
    if not name:
        return json.dumps({"error": "name is required"})
    contact_email = (args.get("contact_email") or "").strip()
    if not contact_email:
        return json.dumps({"error": "contact_email is required"})

    logo_url = (args.get("logo_url") or "").strip()
    description = args.get("description")
    background_url = args.get("background_url")

    async def _resolve_media_id_url(field: str) -> Optional[str]:
        raw = args.get(field)
        if raw is None:
            return None
        if not isinstance(raw, str) or not raw.strip():
            return None
        mid = raw.strip()
        try:
            mid_uuid = uuid.UUID(mid)
        except ValueError:
            return None

        repo = ctx.get("chat_repo")
        uid_raw = ctx.get("user_id")
        if not isinstance(repo, ChatRepository) or not isinstance(uid_raw, str):
            return None
        try:
            uid = uuid.UUID(uid_raw)
        except ValueError:
            return None

        rows = await list_chat_media_for_user_ids(repo.session, uid, [mid_uuid])
        if not rows:
            return None
        u = rows[0].url.strip()
        return u if u.startswith(("http://", "https://")) else None

    # Prefer explicit URL; if omitted, resolve from ai-service chat media ids.
    if not logo_url:
        resolved_logo = await _resolve_media_id_url("logo_media_id")
        logo_url = resolved_logo or _DEFAULT_LOGO_URL
    resolved_bg = await _resolve_media_id_url("background_media_id")
    if resolved_bg:
        background_url = resolved_bg

    payload: dict[str, Any] = {
        "name": name,
        "logoUrl": logo_url,
        "contactEmail": contact_email,
    }
    if description is not None and str(description).strip():
        payload["description"] = str(description).strip()
    if background_url is not None and str(background_url).strip():
        payload["backgroundUrl"] = str(background_url).strip()

    return await incident_request_json(
        "POST",
        "/api/v1/organizations",
        ctx,
        json_body=payload,
    )


async def _list_organizations(args: dict[str, Any], ctx: ToolContext) -> str:
    params: list[tuple[str, str]] = []

    if search := (args.get("search") or "").strip():
        params.append(("search", search))

    def _int_statuses(value: Any) -> list[int]:
        if value is None:
            return []
        if isinstance(value, list):
            return [int(x) for x in value]
        return [int(value)]

    for st in _int_statuses(args.get("status")):
        params.append(("status", str(st)))

    if args.get("is_email_verified") is not None:
        v = args["is_email_verified"]
        if isinstance(v, bool):
            params.append(("is_email_verified", "true" if v else "false"))
        else:
            params.append(("is_email_verified", str(v).lower()))

    for st in _int_statuses(args.get("request_status")):
        params.append(("request_status", str(st)))

    if args.get("page") is not None:
        params.append(("page", str(int(args["page"]))))
    if args.get("limit") is not None:
        params.append(("limit", str(int(args["limit"]))))

    if sb := args.get("sort_by"):
        params.append(("sortBy", str(sb)))
    if so := args.get("sort_order"):
        params.append(("sortOrder", str(so)))

    return await incident_request_json(
        "GET",
        "/api/v1/organizations",
        ctx,
        params=params or None,
    )


create_organization_tool = RegisteredTool(
    name="create_organization",
    description=(
        "Creates an organization for the authenticated user (they become owner). "
        "Requires name, contact_email, and optionally description, logo_url (HTTPS URL), "
        "background_url. If logo_url is omitted, a placeholder image URL is used for testing."
    ),
    parameters={
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Organization name (max 200 chars)"},
            "contact_email": {
                "type": "string",
                "description": "Contact email for verification",
            },
            "description": {"type": "string", "description": "Optional description"},
            "logo_url": {
                "type": "string",
                "description": "Optional HTTPS logo URL; placeholder used if omitted. If not provided, tool can resolve from logo_media_id.",
            },
            "background_url": {"type": "string", "description": "Optional background image URL. If omitted, tool can resolve from background_media_id."},
            "logo_media_id": {
                "type": "string",
                "description": "Optional ai_chat_media UUID for logo image (resolved to URL before calling organization API).",
            },
            "background_media_id": {
                "type": "string",
                "description": "Optional ai_chat_media UUID for background image (resolved to URL before calling organization API).",
            },
        },
        "required": ["name", "contact_email"],
    },
    handler=_create_organization,
)

list_organizations_tool = RegisteredTool(
    name="list_organizations",
    description=(
        "Lists organizations the user can discover (same as website directory). "
        "Supports optional filters: search text, status (org lifecycle int or array of ints), "
        "is_email_verified, request_status (join-request filter int or array), pagination "
        "(page, limit), sort_by (createdAt|updatedAt|name), sort_order (asc|desc)."
    ),
    parameters={
        "type": "object",
        "properties": {
            "search": {"type": "string"},
            "status": {
                "type": "array",
                "items": {"type": "integer"},
                "description": "Optional status codes to filter (repeat as HTTP status=); e.g. [12]",
            },
            "is_email_verified": {"type": "boolean"},
            "request_status": {
                "type": "array",
                "items": {"type": "integer"},
                "description": "Optional join-request status filter for the viewer",
            },
            "page": {"type": "integer", "minimum": 1},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            "sort_by": {
                "type": "string",
                "enum": ["createdAt", "updatedAt", "name"],
            },
            "sort_order": {"type": "string", "enum": ["asc", "desc"]},
        },
        "required": [],
    },
    handler=_list_organizations,
)
