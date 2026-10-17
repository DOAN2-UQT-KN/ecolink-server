"""Unit tests for media hash helpers and report-level duplicate cascade."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional
from unittest.mock import patch

from app.verification.contracts import (
    DuplicateMediaMatch,
    DuplicateReportResult,
    ReasonCode,
    ReportSubmittedPayload,
)
from app.verification.duplicate import (
    phash_similarity,
    run_duplicate_cascade,
)
from app.verification.hash_compute import (
    ComputedMediaHashes,
    hamming_distance_hex,
)


def test_hamming_distance_identical() -> None:
    assert hamming_distance_hex("a" * 16, "a" * 16) == 0


def test_hamming_distance_known() -> None:
    # nibble 0 vs 1 → 1 bit
    assert hamming_distance_hex("0" + "a" * 15, "1" + "a" * 15) == 1


def test_payload_parses_full_media() -> None:
    payload = ReportSubmittedPayload.from_dict(
        {
            "reportId": "r1",
            "userId": "u1",
            "reportMediaFileIds": ["rmf1"],
            "media": [
                {
                    "reportMediaFileId": "rmf1",
                    "mediaId": "mid1",
                    "uploadedBy": "u1",
                    "url": "https://cdn.example/a.jpg",
                    "type": "REPORT",
                    "mimeType": "image/jpeg",
                    "fileSize": "123",
                    "width": 100,
                    "height": 80,
                    "capturedAt": "2026-01-01T00:00:00.000Z",
                    "latitude": 1.2,
                    "longitude": 3.4,
                    "cameraMake": "Apple",
                    "cameraModel": "iPhone",
                    "metadata": {"Make": "Apple"},
                }
            ],
        }
    )
    assert len(payload.media) == 1
    assert payload.media[0].url == "https://cdn.example/a.jpg"
    assert payload.media[0].camera_make == "Apple"
    assert payload.media[0].width == 100


@dataclass
class _FakeHit:
    report_id: str
    user_id: Optional[str]
    media_id: str
    hash: str
    algorithm: str


def _records(*items: tuple[str, str, str]) -> list[ComputedMediaHashes]:
    """(report_media_file_id, media_id, phash) → ComputedMediaHashes."""
    out: list[ComputedMediaHashes] = []
    for rmf, media_id, phash in items:
        out.append(
            ComputedMediaHashes(
                report_media_file_id=rmf,
                media_id=media_id,
                url=f"https://cdn.example/{media_id}.jpg",
                phash=phash,
            )
        )
    return out


def test_phash_skips_inactive_report_and_keeps_live(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.verification.duplicate.inactive_report_ids_sync",
        lambda report_ids: {"r-inactive"},
    )
    payload = ReportSubmittedPayload("r-new", "u1", ["rmf1"], media=[])
    context = {"media_hashes": _records(("rmf1", "m1", "0000000000000000"))}
    corpus = [
        _FakeHit("r-inactive", "u1", "m-old-a", "0000000000000000", "PHASH"),
        _FakeHit("r-live", "u1", "m-old-b", "1000000000000000", "PHASH"),
    ]

    with patch(
        "app.verification.duplicate.hash_repo.list_phash_corpus_sync",
        return_value=corpus,
    ):
        result = phash_similarity(payload, context)

    assert result is not None
    assert result.duplicate_report_ids == ["r-live"]


def test_phash_hit() -> None:
    payload = ReportSubmittedPayload("r-new", "u1", ["rmf1"], media=[])
    context = {"media_hashes": _records(("rmf1", "m1", "0000000000000000"))}
    corpus = [_FakeHit("r-old", "u1", "m-old", "1000000000000000", "PHASH")]

    with patch(
        "app.verification.duplicate.hash_repo.list_phash_corpus_sync",
        return_value=corpus,
    ) as ph_mock:
        result = run_duplicate_cascade(payload, context)
        assert result.report_id == "r-new"
        assert result.duplicate_report_ids == ["r-old"]
        assert result.reason == ReasonCode.DUPLICATE_IMAGE.value
        assert result.matches[0].media_id == "m1"
        assert result.matches[0].duplicate_media_id == "m-old"
        assert result.matches[0].reason == ReasonCode.HIGH_IMAGE_SIMILARITY.value
        ph_mock.assert_called_with(user_id="u1", exclude_report_id="r-new")


def test_phash_miss_above_threshold() -> None:
    payload = ReportSubmittedPayload("r-new", "u1", ["rmf1"], media=[])
    context = {"media_hashes": _records(("rmf1", "m1", "0000000000000000"))}
    corpus = [_FakeHit("r-old", "u1", "m-old", "ffffffffffffffff", "PHASH")]

    with patch(
        "app.verification.duplicate.hash_repo.list_phash_corpus_sync",
        return_value=corpus,
    ):
        assert phash_similarity(payload, context) is None


def test_cascade_no_hit_returns_empty_result() -> None:
    payload = ReportSubmittedPayload("r-new", "u1", ["rmf1"], media=[])
    context = {"media_hashes": _records(("rmf1", "m1", "0000000000000000"))}

    with patch(
        "app.verification.duplicate.hash_repo.list_phash_corpus_sync",
        return_value=[],
    ):
        result = run_duplicate_cascade(payload, context)

    assert isinstance(result, DuplicateReportResult)
    assert result.report_id == "r-new"
    assert result.duplicate_report_ids == []
    assert result.reason is None
    assert result.matches == []
    assert result.to_dict() == {
        "report_id": "r-new",
        "duplicate_report_ids": [],
        "reason": None,
        "matches": [],
    }


def test_incident_payload_omits_report_id() -> None:
    result = DuplicateReportResult(
        report_id="r-new",
        duplicate_report_ids=["r-old"],
        reason=ReasonCode.DUPLICATE_IMAGE.value,
        matches=[
            DuplicateMediaMatch(
                media_id="m1",
                duplicate_media_id="m-old",
                duplicate_report_id="r-old",
                reason=ReasonCode.HIGH_IMAGE_SIMILARITY.value,
            )
        ],
    )
    payload = result.to_incident_payload()
    assert "report_id" not in payload
    assert payload == [
        {
            "duplicate_report_id": "r-old",
            "matches": [
                {"media_id": "m1", "duplicate_media_id": "m-old"},
            ],
        }
    ]


def test_delete_hashes_by_media_ids_empty_or_invalid() -> None:
    from app.repositories.media_content_hash import delete_hashes_by_media_ids_sync

    assert delete_hashes_by_media_ids_sync([]) == 0
    assert delete_hashes_by_media_ids_sync(["not-a-uuid", "also-invalid"]) == 0
