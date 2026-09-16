"""Default the inactive-report lookup so cascade tests do not call incident-service."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _inactive_reports_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.verification.duplicate.inactive_report_ids_sync",
        lambda report_ids: set(),
    )
