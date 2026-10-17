"""SafeFetcher (specs/011 US4): no request ever reaches a private, loopback, link-local or metadata address."""

from __future__ import annotations

import asyncio
from typing import Optional

import httpx
import pytest

from app.verification.duplicate_check.safe_fetch import SafeFetcher, ip_allowed

PUBLIC_IP = "93.184.216.34"
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 100

DNS = {
    "img.example": [PUBLIC_IP],
    "loopback.example": ["127.0.0.1"],
    "ten.example": ["10.0.0.5"],
    "home.example": ["192.168.1.1"],
    "metadata.example": ["169.254.169.254"],
    "v6loop.example": ["::1"],
    "ula.example": ["fd00::1"],
    "mapped.example": ["::ffff:127.0.0.1"],
    "zero.example": ["0.0.0.0"],
    "mixed.example": [PUBLIC_IP, "10.0.0.7"],
    "internal.example": ["10.1.2.3"],
    "rebind.example": [PUBLIC_IP],
}


class FakeStream:
    def __init__(self, ip: str) -> None:
        self.ip = ip

    def get_extra_info(self, info: str):
        return (self.ip, 443) if info == "server_addr" else None


async def resolve(host: str) -> list[str]:
    if host not in DNS:
        raise OSError("NXDOMAIN")
    return DNS[host]


class Recorder:
    """Mock network: every request that reaches it is recorded."""

    def __init__(self, routes: dict[str, httpx.Response], delay: float = 0) -> None:
        self.routes = routes
        self.delay = delay
        self.requests: list[httpx.Request] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.delay:
            await asyncio.sleep(self.delay)
        res = self.routes.get(str(request.url), httpx.Response(404))
        host = request.url.host
        peer = "10.9.9.9" if host == "rebind.example" else (DNS.get(host) or [host])[0]
        return httpx.Response(
            res.status_code, headers=res.headers, content=res.content, extensions={"network_stream": FakeStream(peer)}
        )


def image(content: bytes = PNG, content_type: str = "image/png") -> httpx.Response:
    return httpx.Response(200, headers={"content-type": content_type}, content=content)


def redirect(to: str) -> httpx.Response:
    return httpx.Response(302, headers={"location": to})


def fetch(url: str, routes: Optional[dict] = None, *, delay: float = 0, max_bytes: int = 5_000_000, timeout_s: float = 2):
    recorder = Recorder(routes or {}, delay)
    fetcher = SafeFetcher(resolver=resolve, transport=httpx.MockTransport(recorder))
    data, reason = asyncio.run(fetcher.fetch(url, timeout_s=timeout_s, max_bytes=max_bytes))
    return data, reason, recorder.requests


def test_public_https_image_is_downloaded_without_credentials() -> None:
    data, reason, requests = fetch("https://img.example/a.png", {"https://img.example/a.png": image()})
    assert data == PNG and reason is None
    assert len(requests) == 1
    sent = {k.lower() for k in requests[0].headers.keys()}
    assert "cookie" not in sent and "authorization" not in sent


@pytest.mark.parametrize(
    "url",
    [
        "http://img.example/a.png",
        "ftp://img.example/a.png",
        "https://img.example:8443/a.png",
        "https://loopback.example/a.png",
        "https://ten.example/a.png",
        "https://home.example/a.png",
        "https://metadata.example/latest/meta-data",
        "https://v6loop.example/a.png",
        "https://ula.example/a.png",
        "https://mapped.example/a.png",
        "https://zero.example/a.png",
        "https://mixed.example/a.png",
        "https://127.0.0.1/a.png",
        "https://169.254.169.254/latest/meta-data",
        "https://[::1]/a.png",
        "https://unknown.example/a.png",
    ],
)
def test_forbidden_targets_are_never_requested(url: str) -> None:
    data, reason, requests = fetch(url, {url: image()})
    assert data is None and reason
    assert requests == []


def test_redirect_to_a_private_host_is_blocked_before_the_second_request() -> None:
    routes = {
        "https://img.example/a.png": redirect("https://internal.example/secret"),
        "https://internal.example/secret": image(),
    }
    data, reason, requests = fetch("https://img.example/a.png", routes)
    assert data is None and reason == "private address"
    assert [str(r.url) for r in requests] == ["https://img.example/a.png"]


def test_two_redirects_are_followed_three_are_refused() -> None:
    routes = {
        "https://img.example/1": redirect("/2"),
        "https://img.example/2": redirect("https://img.example/3"),
        "https://img.example/3": image(),
    }
    assert fetch("https://img.example/1", routes)[0] == PNG

    routes["https://img.example/3"] = redirect("/4")
    routes["https://img.example/4"] = image()
    data, reason, requests = fetch("https://img.example/1", routes)
    assert data is None and reason == "too many redirects"
    assert "https://img.example/4" not in [str(r.url) for r in requests]


def test_rebound_peer_address_is_refused_before_reading_the_body() -> None:
    data, reason, _ = fetch("https://rebind.example/a.png", {"https://rebind.example/a.png": image()})
    assert data is None and reason == "peer address"


def test_missing_peer_address_fails_closed() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return image()

    fetcher = SafeFetcher(resolver=resolve, transport=httpx.MockTransport(handler))
    data, reason = asyncio.run(fetcher.fetch("https://img.example/a.png", timeout_s=2, max_bytes=1000))
    assert data is None and reason == "peer address"


def test_non_image_content_is_refused() -> None:
    url = "https://img.example/page"
    data, reason, _ = fetch(url, {url: image(b"<html>", "text/html")})
    assert data is None and reason == "not an image"


def test_body_over_the_limit_is_refused() -> None:
    url = "https://img.example/big.png"
    data, reason, _ = fetch(url, {url: image(b"0" * 2000)}, max_bytes=1000)
    assert data is None and reason == "too large"


def test_slow_server_times_out() -> None:
    url = "https://img.example/slow.png"
    data, reason, _ = fetch(url, {url: image()}, delay=1.0, timeout_s=0.05)
    assert data is None and reason == "timeout"


def test_fetch_all_keeps_order_and_failures() -> None:
    fetcher = SafeFetcher(resolver=resolve, transport=httpx.MockTransport(Recorder({"https://img.example/a.png": image()})))
    out = asyncio.run(
        fetcher.fetch_all(["https://ten.example/x", "https://img.example/a.png"], timeout_s=2, max_bytes=10_000)
    )
    assert out == [None, PNG]


@pytest.mark.parametrize(
    "address, allowed",
    [(PUBLIC_IP, True), ("2606:4700::1111", True), ("172.16.0.1", False), ("100.64.0.1", False), ("fe80::1", False)],
)
def test_ip_allowed(address: str, allowed: bool) -> None:
    assert ip_allowed(address) is allowed
