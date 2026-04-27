"""Shared HTTP client for incident-service (JWT from tool context)."""

from __future__ import annotations

import json
from typing import Any, Optional

import httpx

from app.config import settings
from app.tools.definitions import ToolContext


def incident_base_url() -> str:
    return settings.incident_api_base_url.rstrip("/")


async def incident_request_json(
    method: str,
    path: str,
    ctx: ToolContext,
    *,
    json_body: Optional[dict[str, Any]] = None,
    params: Optional[list[tuple[str, str]]] = None,
) -> str:
    token = ctx.get("access_token")
    if not token or not isinstance(token, str):
        return json.dumps({"error": "Missing access_token for API call"})

    url = f"{incident_base_url()}{path}"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            r = await client.request(
                method,
                url,
                headers=headers,
                json=json_body,
                params=params,
            )
    except httpx.RequestError as e:
        return json.dumps({"error": f"Request failed: {e!s}"})

    try:
        body = r.json()
    except json.JSONDecodeError:
        return json.dumps(
            {"error": "Non-JSON response", "status": r.status_code, "text": r.text[:500]}
        )

    if r.status_code >= 400:
        return json.dumps(
            {
                "error": "Upstream error",
                "status": r.status_code,
                "body": body,
            }
        )
    return json.dumps(body, default=str)
