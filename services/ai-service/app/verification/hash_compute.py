"""Download image bytes and compute SHA-256 / DCT pHash for duplicate detection."""

from __future__ import annotations

import hashlib
import io
import logging
from dataclasses import dataclass
from typing import Optional

import httpx
import imagehash
from PIL import Image

from app.verification.contracts import ReportSubmittedMedia, ReportSubmittedPayload

logger = logging.getLogger("ai-service.verification.hash")

DOWNLOAD_TIMEOUT_S = 15.0
MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024

ALG_SHA256 = "SHA256"
ALG_PHASH = "PHASH"
PHASH_HAMMING_THRESHOLD = 10


@dataclass
class ComputedMediaHashes:
    report_media_file_id: str
    media_id: str
    url: str
    sha256: Optional[str] = None
    phash: Optional[str] = None


def hamming_distance_hex(a: str, b: str) -> int:
    """Bit Hamming distance between two equal-length lowercase/uppercase hex strings."""
    if not a or not b or len(a) != len(b):
        raise ValueError("hex hashes must be non-empty and equal length")
    a_l = a.lower()
    b_l = b.lower()
    if any(c not in "0123456789abcdef" for c in a_l + b_l):
        raise ValueError("invalid hex characters")
    distance = 0
    for ca, cb in zip(a_l, b_l):
        distance += bin(int(ca, 16) ^ int(cb, 16)).count("1")
    return distance


def compute_sha256(buffer: bytes) -> Optional[str]:
    if not buffer:
        return None
    return hashlib.sha256(buffer).hexdigest()


def compute_phash_hex(buffer: bytes) -> Optional[str]:
    """DCT pHash via imagehash → 16-char hex (64-bit)."""
    if not buffer:
        return None
    try:
        image = Image.open(io.BytesIO(buffer))
        image.load()
        digest = imagehash.phash(image)
        return str(digest)
    except Exception as err:  # noqa: BLE001 — decode failures are expected
        logger.warning("pHash failed: %s", err)
        return None


# Browser-like UA: some CDNs reject default python-httpx clients.
_DOWNLOAD_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; EcoLinkAI/1.0; +https://ecolink.local) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
}


def download_image_bytes(url: str) -> Optional[bytes]:
    try:
        # trust_env=False: ignore HTTP(S)_PROXY from the process env. Cursor /
        # sandbox proxies often return 403 on CONNECT to CDNs like Cloudinary.
        with httpx.Client(
            timeout=DOWNLOAD_TIMEOUT_S,
            follow_redirects=True,
            trust_env=False,
            headers=_DOWNLOAD_HEADERS,
        ) as client:
            response = client.get(url)
            response.raise_for_status()
            data = response.content
            if len(data) > MAX_DOWNLOAD_BYTES:
                logger.warning("image too large url=%s size=%s", url, len(data))
                return None
            return data
    except Exception as err:  # noqa: BLE001
        logger.warning("download failed url=%s err=%s", url, err)
        return None


def compute_hashes_for_media(item: ReportSubmittedMedia) -> ComputedMediaHashes:
    result = ComputedMediaHashes(
        report_media_file_id=item.report_media_file_id,
        media_id=item.media_id,
        url=item.url,
    )
    buffer = download_image_bytes(item.url)
    if not buffer:
        return result
    result.sha256 = compute_sha256(buffer)
    result.phash = compute_phash_hex(buffer)
    return result


def prepare_media_hashes(payload: ReportSubmittedPayload) -> list[ComputedMediaHashes]:
    """Download + hash each media once for the cascade (stored on context)."""
    return [compute_hashes_for_media(item) for item in payload.media]
