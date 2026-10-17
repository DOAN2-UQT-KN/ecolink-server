"""An image of the report under check, prepared once and shared by every signal of DuplicateCheck."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from app.config import settings
from app.verification.duplicate.orb import OrbFeatures, OrbMatchConfig, extract_orb


@dataclass
class PreparedImage:
    index: int
    media_id: str
    report_media_file_id: str
    phash_hex: str
    q: int
    q_flip: int
    data: bytes
    flipped_data: Optional[bytes]
    orb: Optional[OrbFeatures] = None
    orb_flipped: Optional[OrbFeatures] = None


def ensure_orb(img: PreparedImage) -> None:
    """CPU-bound: call from a worker thread."""
    if img.orb is None:
        img.orb = extract_orb(img.data, media_id=img.media_id)
    if img.orb_flipped is None and img.flipped_data:
        img.orb_flipped = extract_orb(img.flipped_data, media_id=img.media_id)


def orb_match_config(min_inliers: int, min_inlier_ratio: float) -> OrbMatchConfig:
    return OrbMatchConfig(
        ratio_threshold=settings.orb_ratio_threshold,
        min_good_matches=settings.orb_min_good_matches,
        min_inlier_count=min_inliers,
        min_inlier_ratio=min_inlier_ratio,
        ransac_reproj_threshold=settings.orb_ransac_reproj_threshold,
    )
