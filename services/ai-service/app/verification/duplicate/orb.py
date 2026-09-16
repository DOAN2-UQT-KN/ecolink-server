"""ORB feature matching: extract, Lowe ratio, RANSAC homography."""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from typing import Optional, Sequence

import numpy as np

logger = logging.getLogger("ai-service.verification.duplicate.orb")

ORB_NFEATURES = 500
ORB_DESCRIPTOR_DIM = 32


@dataclass(frozen=True)
class OrbMatchConfig:
    """Gates for Lowe-filtered matches and RANSAC inliers."""

    ratio_threshold: float = 0.75
    min_good_matches: int = 8
    min_inlier_count: int = 15
    min_inlier_ratio: float = 0.30
    ransac_reproj_threshold: float = 5.0


@dataclass
class OrbFeatures:
    media_id: str
    keypoints_xy: np.ndarray
    descriptors: np.ndarray

    @property
    def keypoint_count(self) -> int:
        if self.keypoints_xy is None or self.keypoints_xy.size == 0:
            return 0
        return int(self.keypoints_xy.shape[0])


@dataclass(frozen=True)
class FeatureMatchResult:
    matched_media_id: str
    good_match_count: int
    inlier_count: int
    inlier_ratio: float
    is_duplicate: bool


def config_from_settings() -> OrbMatchConfig:
    from app.config import settings

    return OrbMatchConfig(
        ratio_threshold=settings.orb_ratio_threshold,
        min_good_matches=settings.orb_min_good_matches,
        min_inlier_count=settings.orb_min_inlier_count,
        min_inlier_ratio=settings.orb_min_inlier_ratio,
        ransac_reproj_threshold=settings.orb_ransac_reproj_threshold,
    )


def _empty_features(media_id: str = "") -> OrbFeatures:
    return OrbFeatures(
        media_id=media_id,
        keypoints_xy=np.zeros((0, 2), dtype=np.float32),
        descriptors=np.zeros((0, ORB_DESCRIPTOR_DIM), dtype=np.uint8),
    )


def _require_cv2():
    import cv2

    return cv2


def extract_orb(image_bytes: bytes, *, media_id: str = "") -> OrbFeatures:
    """Detect ORB keypoints and binary descriptors. Empty image → empty arrays."""
    if not image_bytes:
        return _empty_features(media_id)
    cv2 = _require_cv2()
    buffer = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(buffer, cv2.IMREAD_GRAYSCALE)
    if image is None:
        logger.warning("ORB decode failed media_id=%s", media_id)
        return _empty_features(media_id)
    detector = cv2.ORB_create(nfeatures=ORB_NFEATURES)
    keypoints, descriptors = detector.detectAndCompute(image, None)
    if not keypoints or descriptors is None:
        return _empty_features(media_id)
    xy = np.array([[kp.pt[0], kp.pt[1]] for kp in keypoints], dtype=np.float32)
    desc = np.ascontiguousarray(descriptors, dtype=np.uint8)
    return OrbFeatures(media_id=media_id, keypoints_xy=xy, descriptors=desc)


def pack_array(array: np.ndarray) -> bytes:
    buf = io.BytesIO()
    np.savez_compressed(buf, data=np.asarray(array))
    return buf.getvalue()


def unpack_array(blob: bytes) -> np.ndarray:
    with np.load(io.BytesIO(blob)) as data:
        return np.asarray(data["data"])


def filter_lowe_ratio(
    knn_matches: Sequence[Sequence[object]],
    *,
    ratio_threshold: float,
) -> list[tuple[int, int]]:
    """Keep best neighbour iff d_best / d_second < ratio_threshold."""
    good: list[tuple[int, int]] = []
    for neighbours in knn_matches:
        if len(neighbours) < 2:
            continue
        best, second = neighbours[0], neighbours[1]
        second_distance = float(getattr(second, "distance"))
        if second_distance <= 0.0:
            continue
        if float(getattr(best, "distance")) / second_distance < ratio_threshold:
            good.append(
                (int(getattr(best, "queryIdx")), int(getattr(best, "trainIdx")))
            )
    return good


def _rejected(
    matched_media_id: str,
    *,
    good_match_count: int = 0,
    inlier_count: int = 0,
) -> FeatureMatchResult:
    ratio = (
        inlier_count / good_match_count if good_match_count else 0.0
    )
    return FeatureMatchResult(
        matched_media_id=matched_media_id,
        good_match_count=good_match_count,
        inlier_count=inlier_count,
        inlier_ratio=ratio,
        is_duplicate=False,
    )


def _as_descriptors(features: OrbFeatures) -> Optional[np.ndarray]:
    desc = features.descriptors
    if desc is None or desc.size == 0:
        return None
    array = np.ascontiguousarray(desc, dtype=np.uint8)
    if array.ndim == 1:
        array = array.reshape(1, -1)
    if array.ndim != 2 or array.shape[0] == 0:
        return None
    return array


def verify_orb_pair(
    query: OrbFeatures,
    candidate: OrbFeatures,
    *,
    config: OrbMatchConfig,
) -> FeatureMatchResult:
    """
    BFMatcher Hamming knnMatch(k=2) → Lowe ratio → RANSAC homography.

    Duplicate only when both inlier count and inlier ratio pass.
    Metrics are filled even when the pair is rejected.
    """
    matched_media_id = candidate.media_id
    query_desc = _as_descriptors(query)
    candidate_desc = _as_descriptors(candidate)
    if query_desc is None or candidate_desc is None or candidate_desc.shape[0] < 2:
        return _rejected(matched_media_id)

    cv2 = _require_cv2()
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    knn = matcher.knnMatch(query_desc, candidate_desc, k=2)
    good = filter_lowe_ratio(knn, ratio_threshold=config.ratio_threshold)
    good_count = len(good)
    if good_count < config.min_good_matches:
        return _rejected(matched_media_id, good_match_count=good_count)

    pts_q = np.asarray(query.keypoints_xy, dtype=np.float32)
    pts_c = np.asarray(candidate.keypoints_xy, dtype=np.float32)
    if pts_q.ndim != 2 or pts_c.ndim != 2 or pts_q.shape[1] < 2 or pts_c.shape[1] < 2:
        return _rejected(matched_media_id, good_match_count=good_count)

    src = []
    dst = []
    for query_idx, train_idx in good:
        if not (0 <= query_idx < len(pts_q) and 0 <= train_idx < len(pts_c)):
            return _rejected(matched_media_id, good_match_count=good_count)
        src.append(pts_q[query_idx, :2])
        dst.append(pts_c[train_idx, :2])

    src_pts = np.asarray(src, dtype=np.float32).reshape(-1, 1, 2)
    dst_pts = np.asarray(dst, dtype=np.float32).reshape(-1, 1, 2)
    try:
        _homography, mask = cv2.findHomography(
            src_pts,
            dst_pts,
            method=cv2.RANSAC,
            ransacReprojThreshold=float(config.ransac_reproj_threshold),
        )
    except cv2.error:
        logger.warning(
            "ORB findHomography failed matched_media_id=%s good=%s",
            matched_media_id,
            good_count,
        )
        return _rejected(matched_media_id, good_match_count=good_count)

    inlier_count = 0
    if mask is not None:
        inlier_count = int(np.asarray(mask).ravel().astype(bool).sum())
    inlier_ratio = inlier_count / good_count if good_count else 0.0
    is_duplicate = (
        inlier_count >= config.min_inlier_count
        and inlier_ratio >= config.min_inlier_ratio
    )
    return FeatureMatchResult(
        matched_media_id=matched_media_id,
        good_match_count=good_count,
        inlier_count=inlier_count,
        inlier_ratio=inlier_ratio,
        is_duplicate=is_duplicate,
    )
