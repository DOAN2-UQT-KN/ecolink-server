"""Download candidate images from URLs that an outside service returned (specs/011 research R6).

The URLs are untrusted, so this blocks SSRF:
- https only, default port;
- every resolved address must be public, checked again after each redirect (at most 2);
- the connected peer is checked once more before the body is read (DNS rebinding);
- no cookies, no credentials, no proxy from the environment;
- image/* only, size and time limited.
Failures never raise: fetch() returns (None, reason).
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
from typing import Any, Awaitable, Callable, Optional, Sequence
from urllib.parse import urljoin, urlsplit

import httpx

logger = logging.getLogger("ai-service.verification.safe_fetch")

MAX_REDIRECTS = 2
REDIRECT_CODES = {301, 302, 303, 307, 308}
HEADERS = {"User-Agent": "EcoLinkAI/1.0 (duplicate image check)", "Accept": "image/*"}

Resolver = Callable[[str], Awaitable[Sequence[str]]]


class Blocked(Exception):
    pass


async def _system_resolve(host: str) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


def ip_allowed(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    # is_global also excludes shared (CGNAT), documentation and benchmark ranges, not only is_private.
    return ip.is_global and not ip.is_multicast


def peer_allowed(response: httpx.Response) -> bool:
    """The address actually connected to; fail closed when the transport does not expose it."""
    stream = response.extensions.get("network_stream")
    addr = stream.get_extra_info("server_addr") if stream is not None else None
    return bool(addr) and ip_allowed(str(addr[0]))


class SafeFetcher:
    def __init__(
        self,
        resolver: Optional[Resolver] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self._resolve = resolver or _system_resolve
        self._transport = transport

    async def _check_url(self, url: str) -> None:
        parts = urlsplit(url)
        if parts.scheme != "https" or not parts.hostname:
            raise Blocked("not https")
        try:
            port = parts.port
        except ValueError:
            raise Blocked("bad port") from None
        if port not in (None, 443):
            raise Blocked("port")
        try:
            ipaddress.ip_address(parts.hostname)
            addresses: Sequence[str] = [parts.hostname]
        except ValueError:
            try:
                addresses = await self._resolve(parts.hostname)
            except OSError:
                raise Blocked("dns") from None
        if not addresses or not all(ip_allowed(a) for a in addresses):
            raise Blocked("private address")

    async def _fetch(self, client: httpx.AsyncClient, url: str, max_bytes: int) -> bytes:
        for _ in range(MAX_REDIRECTS + 1):
            await self._check_url(url)
            async with client.stream("GET", url) as res:
                if not peer_allowed(res):
                    raise Blocked("peer address")
                if res.status_code in REDIRECT_CODES:
                    location = res.headers.get("location")
                    if not location:
                        raise Blocked("redirect without location")
                    url = urljoin(url, location)
                    continue
                if res.status_code != 200:
                    raise Blocked(f"HTTP {res.status_code}")
                if not res.headers.get("content-type", "").lower().startswith("image/"):
                    raise Blocked("not an image")
                body = bytearray()
                async for chunk in res.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        raise Blocked("too large")
                return bytes(body)
        raise Blocked("too many redirects")

    async def fetch(self, url: str, *, timeout_s: float, max_bytes: int) -> tuple[Optional[bytes], Optional[str]]:
        try:
            async with httpx.AsyncClient(
                follow_redirects=False,
                trust_env=False,
                headers=HEADERS,
                timeout=timeout_s,
                transport=self._transport,
            ) as client:
                data = await asyncio.wait_for(self._fetch(client, url, max_bytes), timeout_s)
            return data, None
        except Blocked as err:
            reason = str(err)
        except asyncio.TimeoutError:
            reason = "timeout"
        except Exception as err:  # noqa: BLE001 — any network error is a failed candidate
            reason = type(err).__name__
        logger.info("web candidate skipped host=%s reason=%s", urlsplit(url).hostname, reason)
        return None, reason

    async def fetch_all(
        self, urls: Sequence[str], *, timeout_s: float, max_bytes: int
    ) -> list[Optional[bytes]]:
        results: list[Any] = await asyncio.gather(
            *(self.fetch(u, timeout_s=timeout_s, max_bytes=max_bytes) for u in urls)
        )
        return [data for data, _ in results]
