"""Report verification pipeline orchestrator."""

from __future__ import annotations

import logging
from typing import Any, Optional

from app.verification.contracts import (
    DuplicateReportResult,
    ReportSubmittedPayload,
)
from app.verification.duplicate import run_duplicate_cascade

logger = logging.getLogger("ai-service.verification")


class VerificationPipeline:
    """
    Duplicate (SHA-256 → pHash) then return.

    Authenticity + risk engines — implement later.
    """

    def __init__(self, risk_engine: Optional[Any] = None) -> None:
        _ = risk_engine

    def run(
        self,
        payload: ReportSubmittedPayload,
        *,
        context: Optional[dict[str, Any]] = None,
        job_id: Optional[str] = None,
    ) -> DuplicateReportResult:
        # Must not use `context or {}` — empty `{}` is falsy and would drop
        # caller-owned context (hashes never reach the REPORT_SUBMITTED upsert).
        ctx = context if context is not None else {}
        logger.info(
            "VerificationPipeline start report_id=%s job_id=%s media_count=%s",
            payload.report_id,
            job_id,
            len(payload.report_media_file_ids),
        )

        result = run_duplicate_cascade(payload, ctx)
        # run_authenticity / risk_engine.assess — implement later

        logger.info(
            "VerificationPipeline done report_id=%s result=%s",
            payload.report_id,
            result.to_dict(),
        )
        return result
