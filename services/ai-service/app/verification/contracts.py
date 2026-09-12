"""Verification pipeline contracts (DTO shapes / reason codes / flag bands)."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class RiskFlag(str, Enum):
    ACCEPT = "ACCEPT"
    REVIEW = "REVIEW"
    REJECT = "REJECT"


# Contract bands (for when Risk Engine is implemented):
# 0.00 ─── 0.30 ─── 0.70 ─── 1.00
#    ACCEPT      REVIEW      REJECT
RISK_FLAG_ACCEPT_MAX = 0.30
RISK_FLAG_REVIEW_MAX = 0.70


class ReasonCode(str, Enum):
    """Final report-level verdict after verification, plus detect / authenticity codes."""

    # Final duplicate verdict (top-level DuplicateReportResult.reason)
    DUPLICATE_IMAGE = "DUPLICATE_IMAGE"
    SAME_PLACE = "SAME_PLACE"

    # Per-match detect methods (DuplicateMediaMatch.reason)
    HIGH_IMAGE_SIMILARITY = "HIGH_IMAGE_SIMILARITY"
    EXACT_HASH_MATCH = "EXACT_HASH_MATCH"

    # Reserved / authenticity (not produced by duplicate cascade yet)
    NEARBY_EXISTING_REPORT = "NEARBY_EXISTING_REPORT"
    EXIF_TIME_MISMATCH = "EXIF_TIME_MISMATCH"
    LIVE_CAMERA_PRESENT = "LIVE_CAMERA_PRESENT"


@dataclass
class ReportSubmittedMedia:
    """Full media snapshot from REPORT_SUBMITTED (incident Media row)."""

    report_media_file_id: str
    media_id: str
    url: str
    type: str
    uploaded_by: Optional[str] = None
    mime_type: Optional[str] = None
    file_size: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    captured_at: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    camera_make: Optional[str] = None
    camera_model: Optional[str] = None
    metadata: Optional[Any] = None

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Optional["ReportSubmittedMedia"]:
        report_media_file_id = raw.get("reportMediaFileId")
        media_id = raw.get("mediaId")
        url = raw.get("url")
        media_type = raw.get("type")
        if not isinstance(report_media_file_id, str) or not report_media_file_id:
            return None
        if not isinstance(media_id, str) or not media_id:
            return None
        if not isinstance(url, str) or not url.strip():
            return None
        if not isinstance(media_type, str) or not media_type:
            media_type = "UNKNOWN"

        def _opt_str(key: str) -> Optional[str]:
            value = raw.get(key)
            return value if isinstance(value, str) and value else None

        def _opt_float(key: str) -> Optional[float]:
            value = raw.get(key)
            if isinstance(value, bool):
                return None
            if isinstance(value, (int, float)):
                return float(value)
            return None

        def _opt_int(key: str) -> Optional[int]:
            value = raw.get(key)
            if isinstance(value, bool):
                return None
            if isinstance(value, int):
                return value
            return None

        file_size_raw = raw.get("fileSize")
        file_size: Optional[str]
        if file_size_raw is None:
            file_size = None
        elif isinstance(file_size_raw, str):
            file_size = file_size_raw or None
        else:
            file_size = str(file_size_raw)

        return cls(
            report_media_file_id=report_media_file_id,
            media_id=media_id,
            url=url.strip(),
            type=media_type,
            uploaded_by=_opt_str("uploadedBy"),
            mime_type=_opt_str("mimeType"),
            file_size=file_size,
            width=_opt_int("width"),
            height=_opt_int("height"),
            captured_at=_opt_str("capturedAt"),
            latitude=_opt_float("latitude"),
            longitude=_opt_float("longitude"),
            camera_make=_opt_str("cameraMake"),
            camera_model=_opt_str("cameraModel"),
            metadata=raw.get("metadata"),
        )


@dataclass
class ReportSubmittedPayload:
    report_id: str
    user_id: str
    report_media_file_ids: list[str]
    media: list[ReportSubmittedMedia] = field(default_factory=list)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "ReportSubmittedPayload":
        report_id = raw.get("reportId")
        user_id = raw.get("userId")
        media_ids = raw.get("reportMediaFileIds")
        if not isinstance(report_id, str) or not report_id:
            raise ValueError("Invalid REPORT_SUBMITTED payload: reportId")
        if not isinstance(user_id, str) or not user_id:
            raise ValueError("Invalid REPORT_SUBMITTED payload: userId")
        if not isinstance(media_ids, list):
            raise ValueError("Invalid REPORT_SUBMITTED payload: reportMediaFileIds")
        cleaned = [m for m in media_ids if isinstance(m, str) and m]

        media_items: list[ReportSubmittedMedia] = []
        raw_media = raw.get("media")
        if isinstance(raw_media, list):
            for item in raw_media:
                if isinstance(item, dict):
                    parsed = ReportSubmittedMedia.from_dict(item)
                    if parsed is not None:
                        media_items.append(parsed)

        if not cleaned and media_items:
            cleaned = [m.report_media_file_id for m in media_items]

        return cls(
            report_id=report_id,
            user_id=user_id,
            report_media_file_ids=cleaned,
            media=media_items,
        )


@dataclass
class DuplicateMediaMatch:
    media_id: str  # Media.id vừa gửi
    duplicate_media_id: str  # Media.id cũ bị trùng
    reason: str  # Detect method, e.g. EXACT_HASH_MATCH / HIGH_IMAGE_SIMILARITY

    def to_dict(self) -> dict[str, str]:
        return {
            "media_id": self.media_id,
            "duplicate_media_id": self.duplicate_media_id,
            "reason": self.reason,
        }


@dataclass
class DuplicateReportResult:
    """Report-level duplicate result after SHA-256 / pHash."""

    report_id: str
    duplicate_report_id: Optional[str] = None
    reason: Optional[str] = None  # Final verdict, e.g. DUPLICATE_IMAGE / SAME_PLACE
    matches: list[DuplicateMediaMatch] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "report_id": self.report_id,
            "duplicate_report_id": self.duplicate_report_id,
            "reason": self.reason,
            "matches": [m.to_dict() for m in self.matches],
        }

    def to_incident_payload(self) -> dict[str, Any]:
        """Body for incident PATCH — omit report_id (path param)."""
        return {
            "duplicate_report_id": self.duplicate_report_id,
            "reason": self.reason,
            "matches": [m.to_dict() for m in self.matches],
        }


@dataclass
class ReportDuplicate:
    matched_report_id: Optional[str] = None
    matched_user_id: Optional[str] = None
    image_similarity: Optional[float] = None
    location_similarity: Optional[float] = None
    time_similarity: Optional[float] = None
    category_similarity: Optional[float] = None
    duplicate_score: Optional[float] = None
    duplicate_reason: Optional[str] = None


@dataclass
class AuthenticityResult:
    camera_score: Optional[float] = None
    exif_score: Optional[float] = None
    internet_score: Optional[float] = None
    authenticity_score: Optional[float] = None
    reasons: list[str] = field(default_factory=list)


@dataclass
class RiskAssessmentDetails:
    duplicate_score: Optional[float] = None
    authenticity_score: Optional[float] = None
    behavior_score: Optional[float] = None
    context_score: Optional[float] = None


@dataclass
class RiskAssessment:
    """Standardized verification output contract."""

    risk_score: Optional[float] = None
    flag: Optional[RiskFlag] = None
    details: RiskAssessmentDetails = field(default_factory=RiskAssessmentDetails)
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "risk_score": self.risk_score,
            "flag": self.flag.value if self.flag else None,
            "details": {
                "duplicate_score": self.details.duplicate_score,
                "authenticity_score": self.details.authenticity_score,
                "behavior_score": self.details.behavior_score,
                "context_score": self.details.context_score,
            },
            "reasons": list(self.reasons),
        }
