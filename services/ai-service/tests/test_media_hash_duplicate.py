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
    exact_hash,
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


def _records(*items: tuple[str, str, str, str]) -> list[ComputedMediaHashes]:
    """(report_media_file_id, media_id, sha256, phash) → ComputedMediaHashes."""
    out: list[ComputedMediaHashes] = []
    for rmf, media_id, sha256, phash in items:
        out.append(
            ComputedMediaHashes(
                report_media_file_id=rmf,
                media_id=media_id,
                url=f"https://cdn.example/{media_id}.jpg",
                sha256=sha256,
                phash=phash,
            )
        )
    return out


def test_exact_hash_hit_short_circuits() -> None:
    payload = ReportSubmittedPayload("r-new", "u1", ["rmf1"], media=[])
    context = {"media_hashes": _records(("rmf1", "m1", "abc", "1111111111111111"))}

    with patch(
        "app.verification.duplicate.hash_repo.find_sha256_match_sync",
        return_value=_FakeHit("r-old", "u1", "m-old", "abc", "SHA256"),
    ) as sha_mock, patch(
        "app.verification.duplicate.hash_repo.list_phash_corpus_sync"
    ) as ph_mock:
        result = run_duplicate_cascade(payload, context)
        assert isinstance(result, DuplicateReportResult)
        assert result.report_id == "r-new"
        assert result.duplicate_report_id == "r-old"
        assert result.reason == ReasonCode.DUPLICATE_IMAGE.value
        assert len(result.matches) == 1
        assert result.matches[0].media_id == "m1"
        assert result.matches[0].duplicate_media_id == "m-old"
        assert result.matches[0].reason == ReasonCode.EXACT_HASH_MATCH.value
        sha_mock.assert_called_with(
            "abc", user_id="u1", exclude_report_id="r-new"
        )
        ph_mock.assert_not_called()


def test_exact_hash_pairs_all_media_on_first_matching_report() -> None:
    payload = ReportSubmittedPayload("r-new", "u1", ["rmf1", "rmf2"], media=[])
    context = {
        "media_hashes": _records(
            ("rmf1", "m-new-1", "hash-a", "aaaaaaaaaaaaaaaa"),
            ("rmf2", "m-new-2", "hash-b", "bbbbbbbbbbbbbbbb"),
        )
    }

    def _sha_lookup(sha256: str, *, user_id: str, exclude_report_id: str) -> _FakeHit:
        assert user_id == "u1"
        assert exclude_report_id == "r-new"
        if sha256 == "hash-a":
            return _FakeHit("r-old", "u1", "m-old-1", "hash-a", "SHA256")
        return _FakeHit("r-old", "u1", "m-old-2", "hash-b", "SHA256")

    with patch(
        "app.verification.duplicate.hash_repo.find_sha256_match_sync",
        side_effect=_sha_lookup,
    ):
        result = exact_hash(payload, context)

    assert result is not None
    assert result.duplicate_report_id == "r-old"
    assert {(m.media_id, m.duplicate_media_id) for m in result.matches} == {
        ("m-new-1", "m-old-1"),
        ("m-new-2", "m-old-2"),
    }


def test_exact_hash_first_matching_report_wins() -> None:
    payload = ReportSubmittedPayload("r-new", "u1", ["rmf1", "rmf2"], media=[])
    context = {
        "media_hashes": _records(
            ("rmf1", "m-new-1", "hash-a", "aaaaaaaaaaaaaaaa"),
            ("rmf2", "m-new-2", "hash-b", "bbbbbbbbbbbbbbbb"),
        )
    }

    def _sha_lookup(sha256: str, *, user_id: str, exclude_report_id: str) -> _FakeHit:
        if sha256 == "hash-a":
            return _FakeHit("r-old-a", "u1", "m-old-a", "hash-a", "SHA256")
        return _FakeHit("r-old-b", "u1", "m-old-b", "hash-b", "SHA256")

    with patch(
        "app.verification.duplicate.hash_repo.find_sha256_match_sync",
        side_effect=_sha_lookup,
    ):
        result = exact_hash(payload, context)

    assert result is not None
    assert result.duplicate_report_id == "r-old-a"
    assert result.matches[0].media_id == "m-new-1"
    assert result.matches[0].duplicate_media_id == "m-old-a"
    assert len(result.matches) == 1


def test_phash_hit_when_sha_misses() -> None:
    payload = ReportSubmittedPayload("r-new", "u1", ["rmf1"], media=[])
    context = {"media_hashes": _records(("rmf1", "m1", "abc", "0000000000000000"))}
    corpus = [_FakeHit("r-old", "u1", "m-old", "1000000000000000", "PHASH")]

    with patch(
        "app.verification.duplicate.hash_repo.find_sha256_match_sync",
        return_value=None,
    ) as sha_mock, patch(
        "app.verification.duplicate.hash_repo.list_phash_corpus_sync",
        return_value=corpus,
    ) as ph_mock:
        result = run_duplicate_cascade(payload, context)
        assert result.report_id == "r-new"
        assert result.duplicate_report_id == "r-old"
        assert result.reason == ReasonCode.DUPLICATE_IMAGE.value
        assert result.matches[0].media_id == "m1"
        assert result.matches[0].duplicate_media_id == "m-old"
        assert result.matches[0].reason == ReasonCode.HIGH_IMAGE_SIMILARITY.value
        sha_mock.assert_called_with(
            "abc", user_id="u1", exclude_report_id="r-new"
        )
        ph_mock.assert_called_with(user_id="u1", exclude_report_id="r-new")


def test_phash_miss_above_threshold() -> None:
    payload = ReportSubmittedPayload("r-new", "u1", ["rmf1"], media=[])
    context = {"media_hashes": _records(("rmf1", "m1", None, "0000000000000000"))}
    corpus = [_FakeHit("r-old", "u1", "m-old", "ffffffffffffffff", "PHASH")]

    with patch(
        "app.verification.duplicate.hash_repo.list_phash_corpus_sync",
        return_value=corpus,
    ):
        assert phash_similarity(payload, context) is None


def test_cascade_no_hit_returns_empty_result() -> None:
    payload = ReportSubmittedPayload("r-new", "u1", ["rmf1"], media=[])
    context = {"media_hashes": _records(("rmf1", "m1", "abc", "0000000000000000"))}

    with patch(
        "app.verification.duplicate.hash_repo.find_sha256_match_sync",
        return_value=None,
    ), patch(
        "app.verification.duplicate.hash_repo.list_phash_corpus_sync",
        return_value=[],
    ):
        result = run_duplicate_cascade(payload, context)

    assert isinstance(result, DuplicateReportResult)
    assert result.report_id == "r-new"
    assert result.duplicate_report_id is None
    assert result.reason is None
    assert result.matches == []
    assert result.to_dict() == {
        "report_id": "r-new",
        "duplicate_report_id": None,
        "reason": None,
        "matches": [],
    }


def test_exact_hash_no_media_returns_none() -> None:
    payload = ReportSubmittedPayload("r1", "u1", ["m1"])
    with patch(
        "app.verification.duplicate.prepare_media_hashes", return_value=[]
    ):
        assert exact_hash(payload, {}) is None


def test_incident_payload_omits_report_id() -> None:
    result = DuplicateReportResult(
        report_id="r-new",
        duplicate_report_id="r-old",
        reason=ReasonCode.DUPLICATE_IMAGE.value,
        matches=[
            DuplicateMediaMatch(
                media_id="m1",
                duplicate_media_id="m-old",
                reason=ReasonCode.EXACT_HASH_MATCH.value,
            )
        ],
    )
    payload = result.to_incident_payload()
    assert "report_id" not in payload
    assert payload == {
        "duplicate_report_id": "r-old",
        "reason": "DUPLICATE_IMAGE",
        "matches": [
            {
                "media_id": "m1",
                "duplicate_media_id": "m-old",
                "reason": "EXACT_HASH_MATCH",
            }
        ],
    }
