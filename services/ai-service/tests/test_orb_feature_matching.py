"""Unit tests for ORB Lowe ratio, RANSAC gates, and cascade wiring."""

from __future__ import annotations

from dataclasses import dataclass
from unittest.mock import patch

import numpy as np

from app.verification.contracts import ReasonCode, ReportSubmittedPayload
from app.verification.duplicate import run_duplicate_cascade
from app.verification.duplicate.orb import (
    OrbFeatures,
    OrbMatchConfig,
    filter_lowe_ratio,
    verify_orb_pair,
)
from app.verification.hash_compute import ComputedMediaHashes


@dataclass
class _Neighbour:
    queryIdx: int
    trainIdx: int
    distance: float


def _pair(n: int, *, media_id: str = "cand") -> tuple[OrbFeatures, OrbFeatures]:
    rng = np.random.default_rng(0)
    desc = rng.integers(0, 256, size=(n, 32), dtype=np.uint8)
    far = np.bitwise_xor(desc[:1], np.uint8(255))
    cand_desc = np.vstack([desc, far])
    xy = np.arange(n * 2, dtype=np.float32).reshape(n, 2)
    cand_xy = np.vstack([xy, np.zeros((1, 2), dtype=np.float32)])
    query = OrbFeatures("query", xy, desc)
    candidate = OrbFeatures(media_id, cand_xy, cand_desc)
    return query, candidate


def test_lowe_ratio_drops_ambiguous_pair() -> None:
    kept = _Neighbour(0, 1, 10.0)
    dropped_best = _Neighbour(1, 2, 40.0)
    dropped_second = _Neighbour(1, 3, 42.0)
    good = filter_lowe_ratio(
        [[kept, _Neighbour(0, 4, 80.0)], [dropped_best, dropped_second]],
        ratio_threshold=0.75,
    )
    assert good == [(0, 1)]


def test_insufficient_good_matches_skips_ransac() -> None:
    query, candidate = _pair(4, media_id="cand-1")
    config = OrbMatchConfig(min_good_matches=8, min_inlier_count=1, min_inlier_ratio=0.0)
    with patch("app.verification.duplicate.orb._require_cv2") as cv2_factory:
        import cv2

        cv2_factory.return_value = cv2
        with patch.object(cv2, "findHomography") as homography:
            result = verify_orb_pair(query, candidate, config=config)
        homography.assert_not_called()
    assert result.is_duplicate is False
    assert result.matched_media_id == "cand-1"
    assert result.good_match_count == 4
    assert result.inlier_count == 0


def test_passing_inliers_returns_candidate_id() -> None:
    query, candidate = _pair(20, media_id="cand-pass")
    config = OrbMatchConfig()
    mask = np.ones((20, 1), dtype=np.uint8)
    with patch("cv2.findHomography", return_value=(np.eye(3), mask)):
        result = verify_orb_pair(query, candidate, config=config)
    assert result.is_duplicate is True
    assert result.matched_media_id == "cand-pass"
    assert result.good_match_count == 20
    assert result.inlier_count == 20
    assert result.inlier_ratio == 1.0


def test_below_inlier_count_keeps_metrics() -> None:
    query, candidate = _pair(20, media_id="cand-low-count")
    config = OrbMatchConfig(min_inlier_count=15, min_inlier_ratio=0.30)
    mask = np.zeros((20, 1), dtype=np.uint8)
    mask[:10] = 1
    with patch("cv2.findHomography", return_value=(np.eye(3), mask)):
        result = verify_orb_pair(query, candidate, config=config)
    assert result.is_duplicate is False
    assert result.good_match_count == 20
    assert result.inlier_count == 10
    assert result.inlier_ratio == 0.5
    assert result.matched_media_id == "cand-low-count"


def test_below_inlier_ratio_keeps_metrics() -> None:
    query, candidate = _pair(60, media_id="cand-low-ratio")
    config = OrbMatchConfig(min_inlier_count=15, min_inlier_ratio=0.30)
    mask = np.zeros((60, 1), dtype=np.uint8)
    mask[:16] = 1
    with patch("cv2.findHomography", return_value=(np.eye(3), mask)):
        result = verify_orb_pair(query, candidate, config=config)
    assert result.is_duplicate is False
    assert result.good_match_count == 60
    assert result.inlier_count == 16
    assert result.inlier_ratio == 16 / 60
    assert result.matched_media_id == "cand-low-ratio"


def test_cascade_orb_hit_after_hash_miss() -> None:
    payload = ReportSubmittedPayload("r-new", "u1", ["rmf1"], media=[])
    query, candidate = _pair(20, media_id="m-old")
    records = [
        ComputedMediaHashes(
            report_media_file_id="rmf1",
            media_id="m-new",
            url="https://cdn.example/a.jpg",
            sha256="abc",
            phash="0000000000000000",
            orb=OrbFeatures("m-new", query.keypoints_xy, query.descriptors),
        )
    ]

    @dataclass
    class _Hit:
        report_id: str
        features: OrbFeatures

    passing = type("R", (), {})()
    passing.matched_media_id = "m-old"
    passing.good_match_count = 20
    passing.inlier_count = 16
    passing.inlier_ratio = 0.8
    passing.is_duplicate = True

    with patch(
        "app.verification.duplicate.hash_repo.find_sha256_matches_sync",
        return_value=[],
    ), patch(
        "app.verification.duplicate.hash_repo.list_phash_corpus_sync",
        return_value=[],
    ), patch(
        "app.verification.duplicate.list_for_user_sync",
        return_value=[_Hit("r-old", candidate)],
    ), patch(
        "app.verification.duplicate.verify_orb_pair",
        return_value=passing,
    ):
        result = run_duplicate_cascade(payload, {"media_hashes": records})

    assert result.duplicate_report_ids == ["r-old"]
    assert result.reason == ReasonCode.DUPLICATE_IMAGE.value
    assert len(result.matches) == 1
    assert result.matches[0].media_id == "m-new"
    assert result.matches[0].duplicate_media_id == "m-old"
    assert result.matches[0].reason == ReasonCode.FEATURE_MATCH.value
