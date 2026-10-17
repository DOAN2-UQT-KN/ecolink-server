"""Google Cloud Vision WEB_DETECTION over REST (specs/011 research R3).

Only the image bytes are sent: no URL, coordinates or text of the report (FR-006).
Never log the key or the request body.
"""

from __future__ import annotations

import base64
from typing import Any, Optional

import httpx

VISION_URL = "https://vision.googleapis.com/v1/images:annotate"


class VisionError(Exception):
    """Vision failed, timed out or ran out of quota: the signal becomes FAILED."""


class VisionClient:
    def __init__(self, api_key: str, transport: Optional[httpx.AsyncBaseTransport] = None) -> None:
        self._key = api_key
        self._transport = transport

    async def web_detection(self, image: bytes, *, max_results: int, timeout_s: float) -> dict[str, Any]:
        body = {
            "requests": [
                {
                    "image": {"content": base64.b64encode(image).decode("ascii")},
                    "features": [{"type": "WEB_DETECTION", "maxResults": max_results}],
                }
            ]
        }
        try:
            async with httpx.AsyncClient(timeout=timeout_s, trust_env=False, transport=self._transport) as client:
                res = await client.post(VISION_URL, params={"key": self._key}, json=body)
        except httpx.HTTPError as err:
            raise VisionError(type(err).__name__) from None  # the message would contain the URL with the key
        if res.status_code // 100 != 2:
            raise VisionError(f"HTTP {res.status_code}")
        try:
            first = (res.json().get("responses") or [{}])[0]
        except ValueError:
            raise VisionError("invalid JSON") from None
        if first.get("error"):
            raise VisionError(str(first["error"].get("message") or first["error"].get("code")))
        return first.get("webDetection") or {}
