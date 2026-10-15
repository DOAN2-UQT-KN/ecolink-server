"""POST /internal/v1/verification/duplicate wiring (specs/006 P06)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db.session import get_session
from app.internal import router as internal_router
from app.main import app
from app.verification.duplicate_check.models import CheckResultOut, SignalOut

KEY = "test-internal-key"
BODY = {
    "report_id": "r1",
    "user_id": "u1",
    "attempt": 1,
    "latitude": 10.79,
    "longitude": 106.68,
    "created_at": "2026-10-16T08:00:00Z",
    "category": "WATERWAY",
    "media": [{"media_id": "m1", "report_media_file_id": "rmf1", "url": "https://x/a.jpg"}],
    "config": {
        "version": "duplicate@2.0.0",
        "phash_global_max": 6,
        "phash_candidate_max": 10,
        "candidate_radius_m": 500,
        "candidate_days": 7,
        "orb_min_inliers": 25,
        "orb_min_inlier_ratio": 0.3,
        "risk": {"phash_strict": 0.9, "phash_loose": 0.75, "orb": 0.7, "internet": 0.85},
    },
}


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(settings, "internal_ai_api_key", KEY)

    async def fake_check(body, corpus):
        assert body.report_id == "r1"
        return CheckResultOut(
            version=body.config.version,
            status="COMPLETED",
            risk=0,
            signals=[
                SignalOut(name="phash", status="COMPLETED", risk=0),
                SignalOut(name="orb", status="COMPLETED", risk=0),
                SignalOut(name="internet", status="NOT_AVAILABLE"),
            ],
            evidence={"candidates_scanned": 0, "images_failed": 0, "match": None},
            duration_ms=5,
        )

    monkeypatch.setattr(internal_router, "run_duplicate_check", fake_check)
    app.dependency_overrides[get_session] = lambda: None
    yield TestClient(app)  # no `with`: skip the lifespan (no DB needed)
    app.dependency_overrides.pop(get_session, None)


URL = "/internal/v1/verification/duplicate"


@pytest.mark.parametrize("headers", [{}, {"x-internal-api-key": "wrong"}])
def test_requires_internal_key(client: TestClient, headers: dict) -> None:
    assert client.post(URL, json=BODY, headers=headers).status_code == 401


def test_returns_check_result(client: TestClient) -> None:
    response = client.post(URL, json=BODY, headers={"x-internal-api-key": KEY})
    assert response.status_code == 200
    body = response.json()
    assert body["check"] == "DUPLICATE" and body["version"] == "duplicate@2.0.0"
    assert [s["name"] for s in body["signals"]] == ["phash", "orb", "internet"]
    assert body["duration_ms"] == 5


def test_rejects_body_without_media(client: TestClient) -> None:
    body = {k: v for k, v in BODY.items() if k != "media"}
    assert client.post(URL, json=body, headers={"x-internal-api-key": KEY}).status_code == 422
