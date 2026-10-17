"""VisionClient (specs/011): request shape and error mapping, never leaking the key."""

from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest

from app.verification.duplicate_check.vision import VisionClient, VisionError


def call(handler, image: bytes = b"jpeg-bytes"):
    client = VisionClient("secret-key", transport=httpx.MockTransport(handler))
    return asyncio.run(client.web_detection(image, max_results=20, timeout_s=4))


def test_sends_only_the_image_bytes_and_returns_web_detection() -> None:
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["body"] = request.url, json.loads(request.content)
        return httpx.Response(200, json={"responses": [{"webDetection": {"fullMatchingImages": [{"url": "u"}]}}]})

    assert call(handler) == {"fullMatchingImages": [{"url": "u"}]}
    assert seen["url"].params["key"] == "secret-key"
    assert seen["body"] == {
        "requests": [
            {
                "image": {"content": base64.b64encode(b"jpeg-bytes").decode()},
                "features": [{"type": "WEB_DETECTION", "maxResults": 20}],
            }
        ]
    }


def test_empty_response_is_no_candidates() -> None:
    assert call(lambda r: httpx.Response(200, json={"responses": [{}]})) == {}


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(429, json={"error": {"message": "quota"}}),
        httpx.Response(200, json={"responses": [{"error": {"code": 3, "message": "Bad image data."}}]}),
        httpx.Response(200, content=b"not json"),
    ],
)
def test_errors_become_vision_error(response: httpx.Response) -> None:
    with pytest.raises(VisionError):
        call(lambda r: response)


def test_network_error_does_not_leak_the_key() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out on " + str(request.url))

    with pytest.raises(VisionError) as err:
        call(handler)
    assert "secret-key" not in str(err.value)
