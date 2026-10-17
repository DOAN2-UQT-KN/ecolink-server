"""Authenticity verification — empty method stubs (scoring deferred)."""

from __future__ import annotations

from typing import Any, Optional

from app.verification.contracts import AuthenticityResult, ReportSubmittedPayload


def live_camera(
    payload: ReportSubmittedPayload,
    context: Optional[dict[str, Any]] = None,
) -> AuthenticityResult:
    """Live-camera evidence check. Not implemented yet."""
    _ = (payload, context)
    return AuthenticityResult()


def exif_verification(
    payload: ReportSubmittedPayload,
    context: Optional[dict[str, Any]] = None,
) -> AuthenticityResult:
    """EXIF metadata verification. Not implemented yet."""
    _ = (payload, context)
    return AuthenticityResult()


def internet_detection(
    payload: ReportSubmittedPayload,
    context: Optional[dict[str, Any]] = None,
) -> AuthenticityResult:
    """Internet reverse-image / provenance check [Future]. Not implemented yet."""
    _ = (payload, context)
    return AuthenticityResult()


def run_authenticity(
    payload: ReportSubmittedPayload,
    context: Optional[dict[str, Any]] = None,
) -> AuthenticityResult:
    """
    Wire live camera + EXIF + internet stubs. Aggregation is deferred;
    returns an empty AuthenticityResult for now.
    """
    live_camera(payload, context)
    exif_verification(payload, context)
    internet_detection(payload, context)
    return AuthenticityResult()
