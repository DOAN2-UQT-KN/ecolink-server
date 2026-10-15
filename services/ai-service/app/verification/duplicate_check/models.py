"""Request / response of POST /internal/v1/verification/duplicate (contracts/internal-duplicate-check.md)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel


class DuplicateRisk(BaseModel):
    phash_strict: float
    phash_loose: float
    orb: float
    internet: float


class DuplicateCheckConfig(BaseModel):
    version: str
    phash_global_max: int
    phash_candidate_max: int
    candidate_radius_m: float
    candidate_days: int
    orb_min_inliers: int
    orb_min_inlier_ratio: float
    risk: DuplicateRisk


class DuplicateCheckMedia(BaseModel):
    media_id: str
    report_media_file_id: str
    url: str


class DuplicateCheckRequest(BaseModel):
    report_id: str
    user_id: Optional[str] = None
    attempt: int = 1
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    created_at: datetime
    category: str
    media: list[DuplicateCheckMedia]
    config: DuplicateCheckConfig


SignalStatus = Literal["COMPLETED", "SKIPPED", "FAILED", "NOT_AVAILABLE"]


class SignalOut(BaseModel):
    name: str
    status: SignalStatus
    risk: Optional[float] = None
    raw: Optional[float] = None


class CheckResultOut(BaseModel):
    check: Literal["DUPLICATE"] = "DUPLICATE"
    version: str
    status: SignalStatus
    risk: Optional[float] = None
    reasons: list[str] = []
    signals: list[SignalOut]
    evidence: dict[str, Any] = {}
    error: Optional[dict[str, str]] = None
    duration_ms: int = 0
