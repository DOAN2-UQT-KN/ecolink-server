"""@da2/queue-compatible background job envelope helpers."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class BackgroundJobEnvelope:
    job_id: str
    job_type: str
    payload: dict[str, Any]
    version: int = 1
    created_at: Optional[str] = None

    @classmethod
    def parse(cls, body: str) -> "BackgroundJobEnvelope":
        raw = json.loads(body)
        if not isinstance(raw, dict):
            raise ValueError("Envelope must be a JSON object")
        job_id = raw.get("jobId")
        job_type = raw.get("jobType")
        payload = raw.get("payload")
        if not isinstance(job_id, str) or not job_id:
            raise ValueError("Envelope missing jobId")
        if not isinstance(job_type, str) or not job_type:
            raise ValueError("Envelope missing jobType")
        if not isinstance(payload, dict):
            raise ValueError("Envelope missing payload object")
        version = raw.get("version", 1)
        if not isinstance(version, int):
            version = 1
        created_at = raw.get("createdAt")
        return cls(
            job_id=job_id,
            job_type=job_type,
            payload=payload,
            version=version,
            created_at=created_at if isinstance(created_at, str) else None,
        )
