"""Pure model round-trip tests (no server needed).

These run on every test invocation regardless of whether the integration
suite finds a working hippo serve subprocess. They lock the wire-shape
contract for each Pydantic model.
"""

from __future__ import annotations

from hippo_memory import (
    HealthInfo, MemoryEnvelope, RecallEntry, RecallResult,
    ContextEntry, ContextResult, OutcomeResult, SleepResult,
    DrillResult, ArchiveResult, SupersedeResult, PromoteResult,
    ForgetResult, AssembleResult, AuthCreated, AuthKey, AuthRevoked,
    AuditEvent, HippoError,
)


def _roundtrip(model_cls, payload: dict) -> None:
    """Validate -> dump -> compare. extra fields stay; alias preserved."""
    instance = model_cls.model_validate(payload)
    dumped = instance.model_dump(by_alias=True, exclude_unset=True)
    # Every input key should round-trip (extra='allow' keeps unknown fields).
    for key in payload:
        assert key in dumped, f"{model_cls.__name__}: key '{key}' lost in round-trip"


def test_health_info_roundtrip():
    _roundtrip(HealthInfo, {
        "ok": True,
        "version": "1.11.4",
        "startedAt": "2026-05-23T18:00:00.000Z",
        "pid": 12345,
    })


def test_memory_envelope_roundtrip():
    _roundtrip(MemoryEnvelope, {
        "id": "mem_abc",
        "content": "test content",
        "tenantId": "default",
        "kind": "distilled",
        "tags": ["test"],
    })


def test_recall_result_roundtrip():
    _roundtrip(RecallResult, {
        "results": [
            {"id": "mem_a", "content": "a", "score": 0.9, "tokens": 5},
            {"id": "mem_b", "content": "b", "score": 0.8, "tokens": 4},
        ],
        "total": 2,
        "tokens": 9,
    })


def test_context_result_roundtrip():
    payload = {
        "entries": [
            {
                "entry": {"id": "mem_x", "content": "x", "tenantId": "default"},
                "score": 1.0,
                "tokens": 5,
            }
        ],
        "tokens": 5,
    }
    instance = ContextResult.model_validate(payload)
    assert instance.entries[0].entry.id == "mem_x"
    assert instance.tokens == 5


def test_outcome_result_with_ids_path():
    """ids-supplied path: server returns just {applied}."""
    instance = OutcomeResult.model_validate({"applied": 2})
    assert instance.applied == 2
    assert instance.ids is None


def test_outcome_result_last_recall_path():
    """last-recall path: server returns {applied, ids} with tenant-filtered ids."""
    instance = OutcomeResult.model_validate({"applied": 2, "ids": ["mem_a", "mem_b"]})
    assert instance.applied == 2
    assert instance.ids == ["mem_a", "mem_b"]


def test_sleep_result_dry_run():
    instance = SleepResult.model_validate({
        "active": 5, "removed": 0, "mergedEpisodic": 2, "newSemantic": 1, "dryRun": True,
    })
    assert instance.dry_run is True
    assert instance.merged_episodic == 2
    assert instance.new_semantic == 1
    assert instance.deduped is None


def test_sleep_result_full_pipeline():
    instance = SleepResult.model_validate({
        "active": 5, "removed": 1, "mergedEpisodic": 2, "newSemantic": 1, "dryRun": False,
        "deduped": {"removed": 1, "semDups": 1, "epiDups": 0, "crossDups": 0},
        "audit": {"errorsRemoved": 0, "warningCount": 3},
        "ambient": {"totalMemories": 5, "avgStrength": 0.7},
    })
    assert instance.dry_run is False
    assert instance.deduped == {"removed": 1, "semDups": 1, "epiDups": 0, "crossDups": 0}
    assert instance.audit == {"errorsRemoved": 0, "warningCount": 3}


def test_archive_supersede_promote_forget_roundtrip():
    _roundtrip(ArchiveResult, {"ok": True, "id": "mem_x", "archivedAt": "2026-05-23T18:00:00Z"})
    _roundtrip(SupersedeResult, {"ok": True, "id": "mem_x", "supersededBy": "mem_y"})
    _roundtrip(PromoteResult, {"ok": True, "sourceId": "mem_x", "globalId": "g_x"})
    _roundtrip(ForgetResult, {"ok": True, "id": "mem_x"})


def test_auth_models_roundtrip():
    _roundtrip(AuthCreated, {
        "keyId": "hk_abc", "key": "sk_secret_plaintext",
        "tenantId": "default", "label": "test-key", "createdAt": "2026-05-23T18:00:00Z",
    })
    _roundtrip(AuthKey, {
        "keyId": "hk_abc", "tenantId": "default", "label": "test-key",
        "createdAt": "2026-05-23T18:00:00Z",
    })
    _roundtrip(AuthRevoked, {"ok": True, "keyId": "hk_abc", "revokedAt": "2026-05-23T18:00:00Z"})


def test_audit_event_roundtrip():
    _roundtrip(AuditEvent, {
        "id": 1, "tenantId": "default", "actor": "localhost:cli",
        "op": "outcome", "targetId": "mem_x", "metadata": {"good": True},
        "createdAt": "2026-05-23T18:00:00Z",
    })


def test_extra_fields_allowed_forward_compat():
    """Server adding a new field doesn't break the SDK (extra='allow')."""
    instance = MemoryEnvelope.model_validate({
        "id": "mem_x", "content": "y", "tenantId": "default",
        "futureField": "value-the-sdk-doesnt-know",
    })
    assert instance.id == "mem_x"
    # extra fields land in model_extra
    assert instance.model_extra.get("futureField") == "value-the-sdk-doesnt-know"


def test_hippo_error_carries_status_and_body():
    err = HippoError(400, "good is required", body={"error": "good is required"})
    assert err.status_code == 400
    assert err.body == {"error": "good is required"}
    assert "400" in str(err)
    assert "good is required" in str(err)
