"""DuplicateCheck signal `internet` (specs/011) with fake Vision, fetcher and store."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Optional, Sequence

import pytest
from PIL import ImageOps

from app.verification.duplicate_check.images import PreparedImage
from app.verification.duplicate_check.internet import WebDeps, filter_candidates, run_internet_signal
from app.verification.duplicate_check.models import DuplicateCheckRequest
from app.verification.duplicate_check.vision import VisionError
from app.verification.hash_compute import compute_phash_hex, mirror_image_bytes, phash_hex_to_int
from test_duplicate_check_service import NOW, textured, to_bytes

ORIGINAL = textured(1)


def prepared(index: int, data: bytes) -> PreparedImage:
    phash = compute_phash_hex(data)
    flipped = mirror_image_bytes(data)
    return PreparedImage(
        index=index,
        media_id=f"m{index}",
        report_media_file_id=f"rmf{index}",
        phash_hex=phash,
        q=phash_hex_to_int(phash),
        q_flip=phash_hex_to_int(compute_phash_hex(flipped)),
        data=data,
        flipped_data=flipped,
    )


def request(sources: Sequence[str], **web: Any) -> DuplicateCheckRequest:
    cfg = {
        "enabled": True,
        "daily_limit": 1000,
        "max_images": 10,
        "batch_size": 3,
        "total_timeout_ms": 8000,
        "blocked_hosts": ["ecolink.example"],
        "blocked_url_prefixes": ["https://res.cloudinary.com/eco/"],
        **web,
    }
    return DuplicateCheckRequest(
        report_id="r-new",
        user_id="u-me",
        created_at=NOW,
        category="WATERWAY",
        media=[
            {"media_id": f"m{i}", "report_media_file_id": f"rmf{i}", "url": f"u{i}", "capture_source": s}
            for i, s in enumerate(sources)
        ],
        config={
            "version": "duplicate@2.1.0",
            "phash_global_max": 6,
            "phash_candidate_max": 10,
            "candidate_radius_m": 500,
            "candidate_days": 7,
            "orb_min_inliers": 25,
            "orb_min_inlier_ratio": 0.3,
            "risk": {"phash_strict": 0.9, "phash_loose": 0.75, "orb": 0.7, "internet": 0.85},
            "web": cfg,
        },
    )


def detection(*full: str, partial: Sequence[str] = (), similar: Sequence[str] = (), page: Optional[str] = None) -> dict:
    out: dict[str, Any] = {
        "fullMatchingImages": [{"url": u} for u in full],
        "partialMatchingImages": [{"url": u} for u in partial],
        "visuallySimilarImages": [{"url": u} for u in similar],
    }
    if page:
        out["pagesWithMatchingImages"] = [
            {"url": page, "pageTitle": "Rác <b>ven kênh</b> &amp; mưa", "fullMatchingImages": [{"url": u} for u in full]}
        ]
    return out


@dataclass
class FakeVision:
    """Answers by image bytes; `default` for any other image."""

    answers: dict[bytes, Any] = field(default_factory=dict)
    default: Any = field(default_factory=dict)
    delay: float = 0
    calls: int = 0

    async def web_detection(self, image: bytes, *, max_results: int, timeout_s: float) -> dict:
        self.calls += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        answer = self.answers.get(image, self.default)
        if isinstance(answer, Exception):
            raise answer
        return answer


@dataclass
class FakeFetcher:
    blobs: dict[str, bytes] = field(default_factory=dict)
    requested: list[str] = field(default_factory=list)

    async def fetch_all(self, urls, *, timeout_s, max_bytes):
        self.requested.extend(urls)
        return [self.blobs.get(u) for u in urls]


@dataclass
class FakeStore:
    cache: dict[str, list] = field(default_factory=dict)
    limit_left: Optional[int] = None
    reserve_error: bool = False

    async def get_candidates(self, phash_hex):
        return self.cache.get(phash_hex)

    async def put_candidates(self, phash_hex, candidates, ttl_days):
        self.cache[phash_hex] = candidates

    async def reserve_call(self, daily_limit):
        if self.reserve_error:
            raise RuntimeError("db down")
        if self.limit_left is None:
            return True
        self.limit_left -= 1
        return self.limit_left >= 0


def run(req, images, vision=None, fetcher=None, store=None):
    deps = WebDeps(store=store or FakeStore(), vision=vision, fetcher=fetcher or FakeFetcher())
    return asyncio.run(run_internet_signal(req, images, deps))


def own_photos(n: int, start: int = 100) -> list[bytes]:
    return [to_bytes(textured(start + i)) for i in range(n)]


# ── US1: matches ──────────────────────────────────────────────────────────────


def test_web_copy_matches_by_phash_with_evidence() -> None:
    mine = to_bytes(ORIGINAL, "JPEG", quality=70)
    web_url = "https://news.example/rac.jpg"
    vision = FakeVision(default=detection(web_url, page="https://news.example/bai-viet"))
    fetcher = FakeFetcher({web_url: to_bytes(ORIGINAL)})

    result = run(request(["GALLERY"]), [prepared(0, mine)], vision, fetcher)

    assert result.signal.status == "COMPLETED" and result.signal.risk == 0.85
    assert result.signal.raw is not None and result.signal.raw <= 10
    assert result.match == {
        "method": "internet",
        "image_index": 0,
        "match_type": "FULL",
        "verified_by": "phash",
        "phash_distance": result.signal.raw,
        "inliers": None,
        "flipped": False,
        "source_url": web_url,
        "page_url": "https://news.example/bai-viet",
        "page_title": "Rác ven kênh & mưa",
    }
    assert result.web == {
        "status": "COMPLETED",
        "gallery_sent": 1,
        "cache_hit": False,
        "vision_candidates": 1,
        "after_filter": 1,
        "downloaded": 1,
    }


def test_cropped_web_copy_matches_by_orb() -> None:
    web_url = "https://news.example/crop.jpg"
    crop = ORIGINAL.crop((100, 80, 560, 420)).resize((640, 480))
    result = run(
        request(["GALLERY"]),
        [prepared(0, to_bytes(ORIGINAL))],
        FakeVision(default=detection(partial=[web_url])),
        FakeFetcher({web_url: to_bytes(crop, "JPEG", quality=80)}),
    )
    assert result.signal.status == "COMPLETED"
    assert result.match["verified_by"] == "orb" and result.match["inliers"] >= 25
    assert result.match["match_type"] == "PARTIAL" and result.match["phash_distance"] is None


def test_mirrored_web_copy_matches_with_flipped() -> None:
    web_url = "https://news.example/flip.jpg"
    result = run(
        request(["GALLERY"]),
        [prepared(0, to_bytes(ORIGINAL))],
        FakeVision(default=detection(web_url)),
        FakeFetcher({web_url: to_bytes(ImageOps.mirror(ORIGINAL))}),
    )
    assert result.match["flipped"] is True


def test_unrelated_web_images_do_not_match() -> None:
    urls = [f"https://news.example/{i}.jpg" for i in range(3)]
    result = run(
        request(["GALLERY"]),
        [prepared(0, to_bytes(ORIGINAL))],
        FakeVision(default=detection(*urls)),
        FakeFetcher({u: to_bytes(textured(50 + i)) for i, u in enumerate(urls)}),
    )
    assert result.signal.status == "COMPLETED" and result.signal.risk == 0 and result.signal.raw == 3
    assert result.match is None and result.web["downloaded"] == 3


def test_filter_candidates_order_blocklist_dedupe_and_limit() -> None:
    web = {
        "fullMatchingImages": [
            {"url": "https://a.example/1.jpg"},
            {"url": "https://a.example/1.jpg"},
            {"url": "http://plain.example/2.jpg"},
            {"url": "https://cdn.ecolink.example/3.jpg"},
            {"url": "https://res.cloudinary.com/eco/image/upload/4.jpg"},
            {"url": "https://res.cloudinary.com/other/image/upload/5.jpg"},
        ],
        "partialMatchingImages": [{"url": f"https://p.example/{i}.jpg"} for i in range(5)],
        "visuallySimilarImages": [{"url": "https://similar.example/x.jpg"}],
    }
    out = filter_candidates(
        web,
        blocked_hosts=["ecolink.example"],
        blocked_url_prefixes=["https://res.cloudinary.com/eco/"],
        limit=5,
    )
    assert [c["image_url"] for c in out] == [
        "https://a.example/1.jpg",
        "https://res.cloudinary.com/other/image/upload/5.jpg",
        "https://p.example/0.jpg",
        "https://p.example/1.jpg",
        "https://p.example/2.jpg",
    ]
    assert [c["match_type"] for c in out] == ["FULL", "FULL", "PARTIAL", "PARTIAL", "PARTIAL"]


# ── US2: when Vision is (not) called ──────────────────────────────────────────


def test_live_photos_only_are_skipped_without_calls() -> None:
    vision = FakeVision()
    result = run(request(["LIVE", "LIVE"]), [prepared(0, own_photos(1)[0]), prepared(1, own_photos(1, 7)[0])], vision)
    assert result.signal.status == "SKIPPED" and vision.calls == 0


@pytest.mark.parametrize("enabled, has_vision", [(False, True), (True, False)])
def test_disabled_or_no_key_is_not_available(enabled: bool, has_vision: bool) -> None:
    vision = FakeVision() if has_vision else None
    result = run(request(["GALLERY"], enabled=enabled), [prepared(0, own_photos(1)[0])], vision)
    assert result.signal.status == "NOT_AVAILABLE"
    assert vision is None or vision.calls == 0


def test_missing_web_config_is_not_available() -> None:
    req = request(["GALLERY"])
    req.config.web = None
    assert run(req, [prepared(0, own_photos(1)[0])], FakeVision()).signal.status == "NOT_AVAILABLE"


def test_cache_hit_skips_vision_but_still_verifies() -> None:
    img = prepared(0, to_bytes(ORIGINAL))
    web_url = "https://news.example/rac.jpg"
    store = FakeStore(cache={img.phash_hex: [{"image_url": web_url, "page_url": None, "page_title": None, "match_type": "FULL"}]})
    vision = FakeVision()
    fetcher = FakeFetcher({web_url: to_bytes(ORIGINAL)})

    result = run(request(["GALLERY"]), [img], vision, fetcher, store)

    assert vision.calls == 0 and fetcher.requested == [web_url]
    assert result.match is not None and result.web["cache_hit"] is True


def test_first_call_fills_the_cache() -> None:
    img = prepared(0, to_bytes(ORIGINAL))
    store = FakeStore()
    run(request(["GALLERY"]), [img], FakeVision(default=detection("https://a.example/x.jpg")), FakeFetcher(), store)
    assert store.cache[img.phash_hex][0]["image_url"] == "https://a.example/x.jpg"


def test_quota_reached_on_first_image_is_not_available() -> None:
    vision = FakeVision()
    result = run(request(["GALLERY"]), [prepared(0, own_photos(1)[0])], vision, store=FakeStore(limit_left=0))
    assert result.signal.status == "NOT_AVAILABLE" and vision.calls == 0


def test_quota_reached_in_second_batch_is_not_available_not_clean() -> None:
    photos = own_photos(5)
    vision = FakeVision()
    result = run(request(["GALLERY"] * 5), [prepared(i, p) for i, p in enumerate(photos)], vision, store=FakeStore(limit_left=4))
    assert result.signal.status == "NOT_AVAILABLE"
    assert vision.calls == 4
    assert result.web["gallery_sent"] == 4


def test_batches_of_three_stop_after_the_matching_batch() -> None:
    photos = own_photos(7)
    photos[4] = to_bytes(ORIGINAL, "JPEG", quality=75)
    web_url = "https://news.example/rac.jpg"
    vision = FakeVision(answers={photos[4]: detection(web_url)})
    fetcher = FakeFetcher({web_url: to_bytes(ORIGINAL)})

    result = run(request(["GALLERY"] * 7), [prepared(i, p) for i, p in enumerate(photos)], vision, fetcher)

    assert vision.calls == 6  # batches 1 (images 0-2) and 2 (images 3-5); batch 3 never runs
    assert result.match["image_index"] == 4
    assert result.web["gallery_sent"] == 6


def test_two_hits_in_one_batch_pick_the_earlier_image() -> None:
    second = textured(2)
    photos = [own_photos(1)[0], to_bytes(ORIGINAL, "JPEG", quality=75), to_bytes(second, "JPEG", quality=75)]
    vision = FakeVision(
        answers={photos[1]: detection("https://a.example/1.jpg"), photos[2]: detection("https://a.example/2.jpg")}
    )
    fetcher = FakeFetcher({"https://a.example/1.jpg": to_bytes(ORIGINAL), "https://a.example/2.jpg": to_bytes(second)})
    result = run(request(["GALLERY"] * 3), [prepared(i, p) for i, p in enumerate(photos)], vision, fetcher)
    assert result.match["image_index"] == 1 and result.match["source_url"] == "https://a.example/1.jpg"


def test_only_ten_gallery_images_are_checked() -> None:
    photos = own_photos(12)
    vision = FakeVision()
    run(request(["GALLERY"] * 12), [prepared(i, p) for i, p in enumerate(photos)], vision)
    assert vision.calls == 10


def test_live_images_are_left_out_of_batches() -> None:
    photos = own_photos(4)
    vision = FakeVision()
    result = run(request(["LIVE", "GALLERY", "LIVE", "GALLERY"]), [prepared(i, p) for i, p in enumerate(photos)], vision)
    assert vision.calls == 2 and result.web["gallery_sent"] == 2


# ── US3: failures stay in this signal ─────────────────────────────────────────


def test_vision_error_fails_the_signal() -> None:
    result = run(request(["GALLERY"]), [prepared(0, own_photos(1)[0])], FakeVision(default=VisionError("HTTP 429")))
    assert result.signal.status == "FAILED" and result.match is None


def test_total_timeout_fails_the_signal() -> None:
    vision = FakeVision(delay=1.0)
    loop_start = asyncio.new_event_loop()
    try:
        started = loop_start.time()
        result = loop_start.run_until_complete(
            run_internet_signal(
                request(["GALLERY"], total_timeout_ms=50),
                [prepared(0, own_photos(1)[0])],
                WebDeps(store=FakeStore(), vision=vision, fetcher=FakeFetcher()),
            )
        )
        elapsed = loop_start.time() - started
    finally:
        loop_start.close()
    assert result.signal.status == "FAILED"
    assert elapsed < 0.5


def test_full_match_that_cannot_be_downloaded_fails_with_candidates() -> None:
    url = "https://news.example/gone.jpg"
    result = run(request(["GALLERY"]), [prepared(0, own_photos(1)[0])], FakeVision(default=detection(url, page="https://news.example/p")))
    assert result.signal.status == "FAILED"
    assert result.web["candidates"] == [
        {"image_url": url, "page_url": "https://news.example/p", "page_title": "Rác ven kênh & mưa", "match_type": "FULL"}
    ]


def test_partial_only_that_cannot_be_downloaded_is_clean() -> None:
    result = run(
        request(["GALLERY"]),
        [prepared(0, own_photos(1)[0])],
        FakeVision(default=detection(partial=["https://news.example/p.jpg"])),
    )
    assert result.signal.status == "COMPLETED" and result.signal.risk == 0


def test_some_candidates_failing_to_download_still_match_the_others() -> None:
    urls = ["https://news.example/gone.jpg", "https://news.example/ok.jpg"]
    result = run(
        request(["GALLERY"]),
        [prepared(0, to_bytes(ORIGINAL))],
        FakeVision(default=detection(*urls)),
        FakeFetcher({urls[1]: to_bytes(ORIGINAL)}),
    )
    assert result.match["source_url"] == urls[1]


def test_a_hit_in_the_batch_wins_over_a_failure() -> None:
    photos = [own_photos(1)[0], to_bytes(ORIGINAL, "JPEG", quality=75)]
    vision = FakeVision(answers={photos[0]: VisionError("boom"), photos[1]: detection("https://a.example/1.jpg")})
    result = run(
        request(["GALLERY"] * 2),
        [prepared(i, p) for i, p in enumerate(photos)],
        vision,
        FakeFetcher({"https://a.example/1.jpg": to_bytes(ORIGINAL)}),
    )
    assert result.signal.status == "COMPLETED" and result.match["image_index"] == 1


def test_quota_counter_error_fails_the_signal_without_calling_vision() -> None:
    vision = FakeVision()
    result = run(request(["GALLERY"]), [prepared(0, own_photos(1)[0])], vision, store=FakeStore(reserve_error=True))
    assert result.signal.status == "FAILED" and vision.calls == 0
