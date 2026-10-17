"""Pure helpers of DuplicateCheck (specs/006 P06)."""

from __future__ import annotations

import io
import random

from PIL import Image

from app.verification.duplicate_check.geo import haversine_m
from app.verification.hash_compute import (
    hamming_distance_hex,
    hamming_int,
    mirror_image_bytes,
    phash_hex_to_int,
)


def test_phash_hex_to_int_is_signed_like_postgres_bigint() -> None:
    assert phash_hex_to_int("ffffffffffffffff") == -1
    assert phash_hex_to_int("0000000000000001") == 1
    assert phash_hex_to_int("8000000000000000") == -(1 << 63)
    assert phash_hex_to_int("7fffffffffffffff") == (1 << 63) - 1


def test_hamming_int_matches_hex_distance() -> None:
    rng = random.Random(7)
    for _ in range(3):
        a = f"{rng.getrandbits(64):016x}"
        b = f"{rng.getrandbits(64):016x}"
        assert hamming_int(phash_hex_to_int(a), phash_hex_to_int(b)) == hamming_distance_hex(a, b)


def test_mirror_image_bytes_flips_horizontally() -> None:
    image = Image.new("RGB", (4, 2), (0, 0, 0))
    image.putpixel((0, 0), (255, 0, 0))
    buf = io.BytesIO()
    image.save(buf, format="PNG")

    flipped = Image.open(io.BytesIO(mirror_image_bytes(buf.getvalue())))
    assert flipped.getpixel((3, 0)) == (255, 0, 0)
    assert flipped.getpixel((0, 0)) == (0, 0, 0)


def test_mirror_image_bytes_returns_none_on_garbage() -> None:
    assert mirror_image_bytes(b"not an image") is None


def test_haversine_about_123m_per_0_0011_degree_lat() -> None:
    assert abs(haversine_m(10.79, 106.68, 10.7911, 106.68) - 122.3) < 2
