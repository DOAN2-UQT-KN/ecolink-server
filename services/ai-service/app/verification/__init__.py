"""Report verification package (Duplicate + Authenticity + Risk stubs)."""

from app.verification.contracts import (
    AuthenticityResult,
    DuplicateMediaMatch,
    DuplicateReportResult,
    ReportDuplicate,
    ReportSubmittedPayload,
    RiskAssessment,
    RiskFlag,
)
from app.verification.pipeline import VerificationPipeline

__all__ = [
    "AuthenticityResult",
    "DuplicateMediaMatch",
    "DuplicateReportResult",
    "ReportDuplicate",
    "ReportSubmittedPayload",
    "RiskAssessment",
    "RiskFlag",
    "VerificationPipeline",
]
