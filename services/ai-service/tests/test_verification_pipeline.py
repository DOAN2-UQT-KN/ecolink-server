"""Unit tests for verification pipeline wiring (empty stubs)."""

from __future__ import annotations

from unittest.mock import patch

from app.queue.envelope import BackgroundJobEnvelope
from app.queue.handlers import dispatch
from app.queue.handlers.report_submitted import handle_report_submitted
from app.verification.contracts import DuplicateReportResult, ReportSubmittedPayload, RiskAssessment
from app.verification.duplicate import (
    embedding_similarity,
    exact_hash,
    feature_matching,
    phash_similarity,
    run_duplicate_cascade,
)
from app.verification.authenticity import (
    exif_verification,
    internet_detection,
    live_camera,
    run_authenticity,
)
from app.verification.pipeline import VerificationPipeline
from app.verification.risk import RuleBasedRiskEngine, assess, combine


def test_payload_from_dict() -> None:
    payload = ReportSubmittedPayload.from_dict(
        {
            "reportId": "r1",
            "userId": "u1",
            "reportMediaFileIds": ["m1", "", 3, "m2"],
        }
    )
    assert payload.report_id == "r1"
    assert payload.user_id == "u1"
    assert payload.report_media_file_ids == ["m1", "m2"]


def test_payload_rejects_invalid() -> None:
    try:
        ReportSubmittedPayload.from_dict({"reportId": "r1"})
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_duplicate_cascade_empty_when_no_hashes() -> None:
    payload = ReportSubmittedPayload("r1", "u1", ["m1"])
    with patch(
        "app.verification.duplicate.prepare_media_hashes", return_value=[]
    ), patch(
        "app.verification.duplicate.hash_repo.find_sha256_match_sync",
        return_value=None,
    ), patch(
        "app.verification.duplicate.hash_repo.list_phash_corpus_sync",
        return_value=[],
    ) as ph_mock:
        assert exact_hash(payload, {}) is None
        assert phash_similarity(payload, {}) is None
        assert embedding_similarity(payload) is None
        assert feature_matching(payload) is None
        result = run_duplicate_cascade(payload, {})
        assert isinstance(result, DuplicateReportResult)
        assert result.report_id == "r1"
        assert result.duplicate_report_id is None
        assert result.reasons == []
        assert result.matches == []
        ph_mock.assert_not_called()


def test_authenticity_stubs_empty() -> None:
    payload = ReportSubmittedPayload("r1", "u1", [])
    assert live_camera(payload).authenticity_score is None
    assert exif_verification(payload).authenticity_score is None
    assert internet_detection(payload).internet_score is None
    assert run_authenticity(payload).authenticity_score is None


def test_risk_stubs_empty() -> None:
    assert combine(None, None, None, None) is None
    assessment = assess(None, run_authenticity(ReportSubmittedPayload("r", "u", [])))
    assert isinstance(assessment, RiskAssessment)
    assert assessment.risk_score is None
    assert assessment.to_dict()["flag"] is None


def test_pipeline_returns_duplicate_result_skips_authenticity_risk() -> None:
    with patch(
        "app.verification.duplicate.prepare_media_hashes", return_value=[]
    ), patch(
        "app.verification.authenticity.run_authenticity"
    ) as auth_mock, patch(
        "app.verification.risk.assess"
    ) as risk_mock:
        result = VerificationPipeline(risk_engine=RuleBasedRiskEngine()).run(
            ReportSubmittedPayload("r1", "u1", ["m1"]),
            job_id="job-1",
        )
    assert isinstance(result, DuplicateReportResult)
    assert result.report_id == "r1"
    assert result.duplicate_report_id is None
    assert result.reasons == []
    assert result.matches == []
    assert result.to_dict() == {
        "report_id": "r1",
        "duplicate_report_id": None,
        "reasons": [],
        "matches": [],
    }
    auth_mock.assert_not_called()
    risk_mock.assert_not_called()


def test_pipeline_preserves_caller_empty_context() -> None:
    """Empty `{}` must not be replaced — hashes need to reach the handler upsert."""
    from app.verification.hash_compute import ComputedMediaHashes

    prepared = [
        ComputedMediaHashes(
            report_media_file_id="rmf1",
            media_id="m1",
            url="https://cdn.example/m1.jpg",
            sha256="abc",
            phash="1111111111111111",
        )
    ]
    context: dict = {}
    with patch(
        "app.verification.duplicate.prepare_media_hashes", return_value=prepared
    ), patch(
        "app.verification.duplicate.hash_repo.find_sha256_match_sync",
        return_value=None,
    ), patch(
        "app.verification.duplicate.hash_repo.list_phash_corpus_sync",
        return_value=[],
    ):
        VerificationPipeline().run(
            ReportSubmittedPayload("r1", "u1", ["rmf1"]),
            context=context,
        )
    assert context.get("media_hashes") is prepared


def test_handle_report_submitted_upserts_hashes_from_context() -> None:
    from app.verification.hash_compute import ComputedMediaHashes

    prepared = [
        ComputedMediaHashes(
            report_media_file_id="rmf1",
            media_id="m1",
            url="https://cdn.example/m1.jpg",
            sha256="abc",
            phash=None,
        )
    ]
    with patch(
        "app.verification.duplicate.prepare_media_hashes", return_value=prepared
    ), patch(
        "app.verification.duplicate.hash_repo.find_sha256_match_sync",
        return_value=None,
    ), patch(
        "app.verification.duplicate.hash_repo.list_phash_corpus_sync",
        return_value=[],
    ), patch(
        "app.queue.handlers.report_submitted.upsert_computed_hashes_sync"
    ) as upsert_mock, patch(
        "app.queue.handlers.report_submitted.patch_duplicate_verification_sync"
    ):
        envelope = BackgroundJobEnvelope(
            job_id="job-1",
            job_type="REPORT_SUBMITTED",
            payload={
                "reportId": "r1",
                "userId": "u1",
                "reportMediaFileIds": ["rmf1"],
            },
        )
        handle_report_submitted(envelope)
        upsert_mock.assert_called_once()
        kwargs = upsert_mock.call_args.kwargs
        assert kwargs["report_id"] == "r1"
        assert kwargs["user_id"] == "u1"
        assert kwargs["records"] is prepared


def test_handle_report_submitted() -> None:
    with patch(
        "app.verification.duplicate.prepare_media_hashes", return_value=[]
    ), patch(
        "app.queue.handlers.report_submitted.upsert_computed_hashes_sync"
    ), patch(
        "app.queue.handlers.report_submitted.patch_duplicate_verification_sync"
    ) as patch_mock:
        envelope = BackgroundJobEnvelope(
            job_id="job-1",
            job_type="REPORT_SUBMITTED",
            payload={
                "reportId": "r1",
                "userId": "u1",
                "reportMediaFileIds": [],
            },
        )
        handle_report_submitted(envelope)
        patch_mock.assert_called_once()
        report_id, payload = patch_mock.call_args[0]
        assert report_id == "r1"
        assert "report_id" not in payload
        assert payload == {
            "duplicate_report_id": None,
            "reasons": [],
            "matches": [],
        }


def test_dispatch_unknown_job_type() -> None:
    envelope = BackgroundJobEnvelope(
        job_id="job-1",
        job_type="UNKNOWN",
        payload={},
    )
    try:
        dispatch(envelope)
        assert False, "expected ValueError"
    except ValueError as err:
        assert "No handler" in str(err)
