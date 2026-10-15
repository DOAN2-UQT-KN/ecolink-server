"""DuplicateCheck cascade (specs/006 P06) with an in-memory corpus and generated images."""

from __future__ import annotations

import asyncio
import io
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional, Sequence

import pytest
from PIL import Image, ImageDraw, ImageOps

from app.verification.duplicate.orb import extract_orb
from app.verification.duplicate_check import service
from app.verification.duplicate_check.corpus import (
    CorpusImage,
    CorpusReport,
    OrbCandidate,
    PhashCandidate,
    PhashHit,
)
from app.verification.duplicate_check.geo import haversine_m
from app.verification.duplicate_check.models import DuplicateCheckRequest
from app.verification.hash_compute import compute_phash_hex, hamming_int, phash_hex_to_int

NOW = datetime(2026, 10, 16, 8, 0, tzinfo=timezone.utc)
HERE = (10.79, 106.68)


def textured(seed: int, size: tuple[int, int] = (640, 480)) -> Image.Image:
    rng = random.Random(seed)
    image = Image.new("RGB", size)
    draw = ImageDraw.Draw(image)
    for x in range(size[0]):
        draw.line([(x, 0), (x, size[1])], fill=(x * 255 // size[0], 90, 160))
    for _ in range(160):
        x, y = rng.randrange(size[0]), rng.randrange(size[1])
        w, h = rng.randrange(10, 90), rng.randrange(10, 90)
        colour = tuple(rng.randrange(256) for _ in range(3))
        (draw.rectangle if rng.random() < 0.5 else draw.ellipse)([x, y, x + w, y + h], fill=colour)
    return image


def to_bytes(image: Image.Image, fmt: str = "PNG", quality: int = 95) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format=fmt, quality=quality)
    return buf.getvalue()


def offset(metres_north: float) -> tuple[float, float]:
    return HERE[0] + metres_north / 111_320, HERE[1]


@dataclass
class _Row:
    report_id: str
    user_id: Optional[str]
    media_id: str
    phash_int: int
    features: object
    latitude: Optional[float]
    longitude: Optional[float]
    created_at: Optional[datetime]


@dataclass
class FakeCorpus:
    rows: list[_Row] = field(default_factory=list)
    upserted: list[CorpusImage] = field(default_factory=list)
    fail_global: bool = False

    def add(self, report_id: str, image: Image.Image, *, user_id: str = "u-other", at=HERE, created=NOW) -> None:
        data = to_bytes(image)
        self.rows.append(
            _Row(
                report_id,
                user_id,
                f"m-{report_id}",
                phash_hex_to_int(compute_phash_hex(data)),
                extract_orb(data, media_id=f"m-{report_id}"),
                at[0] if at else None,
                at[1] if at else None,
                created,
            )
        )

    async def find_global_phash(self, *, q, q_flip, max_distance, exclude_report_id, limit=20) -> list[PhashHit]:
        if self.fail_global:
            raise RuntimeError("db down")
        hits = []
        for r in self.rows:
            d, d_flip = hamming_int(q, r.phash_int), hamming_int(q_flip, r.phash_int)
            if r.report_id != exclude_report_id and min(d, d_flip) <= max_distance:
                hits.append(PhashHit(r.report_id, r.user_id, r.media_id, min(d, d_flip), d_flip < d,
                                     r.latitude, r.longitude, r.created_at))
        return sorted(hits, key=lambda h: h.distance)[:limit]

    def _near(self, lat, lng, radius_m, since, exclude_report_id):
        return [
            r for r in self.rows
            if r.report_id != exclude_report_id and r.latitude is not None
            and haversine_m(lat, lng, r.latitude, r.longitude) <= radius_m and r.created_at >= since
        ]

    async def list_phash_candidates(self, **geo) -> list[PhashCandidate]:
        return [PhashCandidate(r.report_id, r.user_id, r.media_id, r.phash_int, r.latitude, r.longitude, r.created_at)
                for r in self._near(**geo)]

    async def list_orb_candidates(self, **geo) -> list[OrbCandidate]:
        return [OrbCandidate(r.report_id, r.user_id, r.media_id, r.features, r.latitude, r.longitude, r.created_at)
                for r in self._near(**geo)]

    async def upsert(self, *, report: CorpusReport, images: Sequence[CorpusImage]) -> None:
        self.upserted.extend(images)


def request(urls: list[str], *, at=HERE) -> DuplicateCheckRequest:
    return DuplicateCheckRequest(
        report_id="r-new",
        user_id="u-me",
        latitude=at[0] if at else None,
        longitude=at[1] if at else None,
        created_at=NOW,
        category="WATERWAY",
        media=[{"media_id": f"m-new-{i}", "report_media_file_id": f"rmf-{i}", "url": u} for i, u in enumerate(urls)],
        config={
            "version": "duplicate@2.0.0",
            "phash_global_max": 6,
            "phash_candidate_max": 10,
            "candidate_radius_m": 500,
            "candidate_days": 7,
            "orb_min_inliers": 25,
            "orb_min_inlier_ratio": 0.3,
            "risk": {"phash_strict": 0.9, "phash_loose": 0.75, "orb": 0.7, "internet": 0.85},
        },
    )


@pytest.fixture
def images(monkeypatch: pytest.MonkeyPatch) -> dict[str, bytes]:
    store: dict[str, bytes] = {}
    monkeypatch.setattr(service, "download_image_bytes", lambda url, timeout=None: store.get(url))
    monkeypatch.setattr(service, "inactive_report_ids_sync", lambda ids: set())
    return store


def run(req: DuplicateCheckRequest, corpus: FakeCorpus):
    return asyncio.run(service.run_duplicate_check(req, corpus))


def signal(result, name):
    return next(s for s in result.signals if s.name == name)


def test_recompressed_copy_from_another_user_matches_globally(images) -> None:
    corpus = FakeCorpus()
    original = textured(1)
    corpus.add("r-old", original, at=offset(2000), created=NOW - timedelta(days=30))
    images["a"] = to_bytes(original, "JPEG", quality=70)

    result = run(request(["a"]), corpus)

    assert result.status == "COMPLETED" and result.risk == 0.9
    assert result.reasons == ["DUP_NEAR_IMAGE_MATCH"]
    assert signal(result, "phash").raw <= 6
    assert signal(result, "orb").status == "SKIPPED"
    assert signal(result, "internet").status == "NOT_AVAILABLE"
    match = result.evidence["match"]
    assert match["report_id"] == "r-old" and match["same_user"] is False and match["method"] == "phash"
    assert 1990 < match["distance_m"] < 2010 and match["time_delta_hours"] == 720


def test_mirrored_copy_matches_with_flipped(images) -> None:
    corpus = FakeCorpus()
    original = textured(2)
    corpus.add("r-old", original)
    images["a"] = to_bytes(ImageOps.mirror(original))

    result = run(request(["a"]), corpus)

    assert result.risk == 0.9
    assert result.evidence["match"]["flipped"] is True


def _crop(image: Image.Image) -> Image.Image:
    w, h = image.size
    return image.crop((int(w * 0.2), int(h * 0.2), int(w * 0.8), int(h * 0.8)))


def test_crop_of_nearby_candidate_matches_by_orb(images) -> None:
    corpus = FakeCorpus()
    original = textured(3)
    corpus.add("r-old", original, at=offset(300), created=NOW - timedelta(days=2))
    images["a"] = to_bytes(_crop(original))

    result = run(request(["a"]), corpus)

    assert result.risk == 0.7, result.signals
    assert result.reasons == ["DUP_FEATURE_MATCH"]
    assert signal(result, "phash").risk == 0
    assert signal(result, "orb").raw >= 25
    assert result.evidence["match"]["method"] == "orb"


def test_crop_of_far_report_is_not_compared_by_orb(images) -> None:
    corpus = FakeCorpus()
    original = textured(3)
    corpus.add("r-old", original, at=offset(2000), created=NOW - timedelta(days=2))
    images["a"] = to_bytes(_crop(original))

    result = run(request(["a"]), corpus)

    assert result.risk == 0 and result.evidence["match"] is None
    assert result.evidence["candidates_scanned"] == 0


def test_rejected_or_deleted_report_is_not_a_duplicate(images, monkeypatch) -> None:
    corpus = FakeCorpus()
    original = textured(4)
    corpus.add("r-rejected", original)
    images["a"] = to_bytes(original)
    monkeypatch.setattr(service, "inactive_report_ids_sync", lambda ids: {"r-rejected"})

    assert run(request(["a"]), corpus).risk == 0


def test_heaviest_image_wins(images) -> None:
    corpus = FakeCorpus()
    loose_src, strict_src = textured(5), textured(6)
    corpus.add("r-strict", strict_src, at=offset(5000))
    corpus.add("r-near", loose_src, at=offset(100))
    images["loose"] = to_bytes(_crop(loose_src))  # only an ORB-level match
    images["strict"] = to_bytes(strict_src)

    result = run(request(["loose", "strict"]), corpus)

    assert result.risk == 0.9
    assert result.evidence["match"]["report_id"] == "r-strict"
    assert result.evidence["match"]["image_index"] == 1


def test_new_image_is_added_to_corpus_and_matched_image_is_not(images) -> None:
    corpus = FakeCorpus()
    images["fresh"] = to_bytes(textured(7))
    result = run(request(["fresh"]), corpus)
    assert result.risk == 0 and result.evidence["match"] is None
    assert [img.media_id for img in corpus.upserted] == ["m-new-0"]
    assert corpus.upserted[0].orb is not None

    corpus2 = FakeCorpus()
    dup = textured(8)
    corpus2.add("r-old", dup)
    images["dup"] = to_bytes(dup)
    run(request(["dup"]), corpus2)
    assert corpus2.upserted == []


def test_all_downloads_failing_is_a_failed_check(images) -> None:
    corpus = FakeCorpus()
    result = run(request(["missing"]), corpus)
    assert result.status == "FAILED" and result.error["code"] == "DOWNLOAD_FAILED"
    assert signal(result, "internet").status == "NOT_AVAILABLE"
    assert corpus.upserted == []


def test_some_downloads_failing_still_runs(images) -> None:
    images["ok"] = to_bytes(textured(9))
    result = run(request(["missing", "ok"]), FakeCorpus())
    assert result.status == "COMPLETED"
    assert result.evidence["images_failed"] == 1


def test_corpus_error_is_a_failed_check(images) -> None:
    images["a"] = to_bytes(textured(10))
    result = run(request(["a"]), FakeCorpus(fail_global=True))
    assert result.status == "FAILED" and result.error["code"] == "ERROR"


def test_report_without_location_only_runs_global_tier(images) -> None:
    corpus = FakeCorpus()
    original = textured(11)
    corpus.add("r-old", original, at=HERE)
    images["a"] = to_bytes(_crop(original))

    result = run(request(["a"], at=None), corpus)

    assert result.risk == 0
    assert signal(result, "orb").status == "SKIPPED"
    assert result.evidence["candidates_scanned"] == 0
