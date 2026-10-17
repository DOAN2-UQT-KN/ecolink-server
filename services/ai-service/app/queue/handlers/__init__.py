"""Job-type → handler registration for the AI SQS worker."""

from __future__ import annotations

from collections.abc import Callable
from typing import Dict

from app.queue.envelope import BackgroundJobEnvelope
from app.queue.handlers.report_submitted import (
    REPORT_SUBMITTED_JOB_TYPE,
    handle_report_submitted,
)

Handler = Callable[[BackgroundJobEnvelope], None]

HANDLERS: Dict[str, Handler] = {
    REPORT_SUBMITTED_JOB_TYPE: handle_report_submitted,
}


def dispatch(envelope: BackgroundJobEnvelope) -> None:
    handler = HANDLERS.get(envelope.job_type)
    if handler is None:
        raise ValueError(f"No handler registered for jobType={envelope.job_type}")
    handler(envelope)
