"""Service-to-service HTTP calls to incident-service (internal API key)."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger("ai-service.clients.incident_internal")

PATCH_TIMEOUT_S = 15.0


def patch_duplicate_verification_sync(
    report_id: str, payload: list[dict[str, Any]] | dict[str, Any]
) -> None:
    """
    Persist DuplicateReportResult onto the incident Report row.
    Payload must not include report_id (the path already identifies the report).
    """
    base = settings.incident_api_base_url.rstrip("/")
    key = (settings.internal_ai_api_key or "").strip()
    if not key:
        raise RuntimeError("INTERNAL_AI_API_KEY is not configured")
    url = f"{base}/internal/v1/reports/{report_id}/duplicate-verification"
    with httpx.Client(timeout=PATCH_TIMEOUT_S) as client:
        response = client.patch(
            url,
            json=payload,
            headers={"x-internal-api-key": key},
        )
        if response.is_error:
            logger.error(
                "duplicate verification PATCH failed report_id=%s status=%s body=%s",
                report_id,
                response.status_code,
                response.text,
            )
        response.raise_for_status()


INACTIVE_IDS_CHUNK = 200


def inactive_report_ids_sync(report_ids: list[str]) -> set[str]:
    """
    Report ids the duplicate cascade must skip (banned or soft-deleted).
    Raises on HTTP failure so the job retries instead of matching inactive reports.
    """
    unique = [report_id for report_id in dict.fromkeys(report_ids) if report_id]
    if not unique:
        return set()
    base = settings.incident_api_base_url.rstrip("/")
    key = (settings.internal_ai_api_key or "").strip()
    if not key:
        raise RuntimeError("INTERNAL_AI_API_KEY is not configured")
    url = f"{base}/internal/v1/reports/inactive-ids"
    inactive: set[str] = set()
    with httpx.Client(timeout=PATCH_TIMEOUT_S) as client:
        for start in range(0, len(unique), INACTIVE_IDS_CHUNK):
            chunk = unique[start : start + INACTIVE_IDS_CHUNK]
            response = client.post(
                url,
                json={"report_ids": chunk},
                headers={"x-internal-api-key": key},
            )
            if response.is_error:
                logger.error(
                    "inactive report lookup failed status=%s body=%s",
                    response.status_code,
                    response.text,
                )
                response.raise_for_status()
            body = response.json()
            data = body.get("data") if isinstance(body, dict) else None
            raw = data.get("report_ids") if isinstance(data, dict) else None
            if isinstance(raw, list):
                inactive.update(item for item in raw if isinstance(item, str) and item)
    return inactive
