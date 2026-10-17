"""Handler for REPORT_SUBMITTED outbox events."""

from __future__ import annotations

import logging

from app.queue.envelope import BackgroundJobEnvelope
from app.repositories.media_content_hash import (
    delete_hashes_by_media_ids_sync,
    upsert_computed_hashes_sync,
)
from app.repositories.media_orb_feature import (
    delete_orb_features_by_media_ids_sync,
    upsert_orb_features_sync,
)
from app.clients.incident_internal import patch_duplicate_verification_sync
from app.verification.contracts import ReportSubmittedPayload
from app.verification.duplicate import CONTEXT_MEDIA_HASHES
from app.verification.pipeline import VerificationPipeline

logger = logging.getLogger("ai-service.queue.report_submitted")

REPORT_SUBMITTED_JOB_TYPE = "REPORT_SUBMITTED"

_pipeline = VerificationPipeline()


def handle_report_submitted(envelope: BackgroundJobEnvelope) -> None:
    if envelope.job_type != REPORT_SUBMITTED_JOB_TYPE:
        raise ValueError(f"Unexpected jobType: {envelope.job_type}")

    payload = ReportSubmittedPayload.from_dict(envelope.payload)
    context: dict = {}
    result = _pipeline.run(
        payload, context=context, job_id=envelope.job_id
    )

    duplicate_media_ids = {
        m.media_id for m in result.matches if m.media_id
    }
    if duplicate_media_ids:
        try:
            delete_hashes_by_media_ids_sync(list(duplicate_media_ids))
            delete_orb_features_by_media_ids_sync(list(duplicate_media_ids))
        except Exception:  # noqa: BLE001
            logger.exception(
                "Failed to delete duplicate media content hashes report_id=%s media_ids=%s",
                payload.report_id,
                duplicate_media_ids,
            )
            raise

    records = context.get(CONTEXT_MEDIA_HASHES) or []
    records_to_upsert = [
        rec for rec in records if rec.media_id not in duplicate_media_ids
    ]
    if records_to_upsert:
        try:
            upsert_computed_hashes_sync(
                report_id=payload.report_id,
                user_id=payload.user_id,
                records=records_to_upsert,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "Failed to upsert media content hashes report_id=%s",
                payload.report_id,
            )
            raise

    if records_to_upsert:
        try:
            upsert_orb_features_sync(
                report_id=payload.report_id,
                user_id=payload.user_id,
                records=records_to_upsert,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "Failed to upsert ORB features report_id=%s",
                payload.report_id,
            )
            raise

    try:
        patch_duplicate_verification_sync(
            payload.report_id, result.to_incident_payload()
        )
    except Exception:  # noqa: BLE001
        logger.exception(
            "Failed to write duplicate verification report_id=%s",
            payload.report_id,
        )
        raise

    logger.info(
        "Handled REPORT_SUBMITTED report_id=%s job_id=%s result=%s",
        payload.report_id,
        envelope.job_id,
        result.to_dict(),
    )
