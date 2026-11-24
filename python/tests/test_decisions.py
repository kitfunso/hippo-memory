from __future__ import annotations

from hippo_memory import (
    Hippo,
    HippoSync,
    Decision,
)


def _roundtrip(model_cls, payload: dict) -> None:
    instance = model_cls.model_validate(payload)
    dumped = instance.model_dump(by_alias=True, exclude_unset=True)
    for key in payload:
        assert key in dumped, f"{model_cls.__name__}: key '{key}' lost in round-trip"


def test_decision_roundtrip_full_shape():
    payload = {
        "id": 42,
        "memoryId": "sem_abc123",
        "tenantId": "default",
        "decisionText": "use Postgres",
        "context": "scale and JSONB",
        "status": "superseded",
        "supersededBy": 43,
        "supersededAt": "2026-05-28T10:00:00Z",
        "closedAt": None,
        "createdAt": "2026-05-28T09:00:00Z",
    }
    _roundtrip(Decision, payload)


def test_decision_defaults_active_with_nulls():
    d = Decision(
        id=1,
        tenant_id="default",
        decision_text="adopt trunk-based dev",
        created_at="2026-05-28T12:00:00Z",
    )
    assert d.status == "active"
    assert d.memory_id is None
    assert d.context is None
    assert d.superseded_by is None
    assert d.superseded_at is None
    assert d.closed_at is None


def test_decision_back_compat_missing_optional_fields():
    payload = {
        "id": 7,
        "tenantId": "default",
        "decisionText": "use trunk-based dev",
        "createdAt": "2026-05-28T12:00:00Z",
    }
    d = Decision.model_validate(payload)
    assert d.id == 7
    assert d.tenant_id == "default"
    assert d.decision_text == "use trunk-based dev"
    assert d.status == "active"
    assert d.context is None


def test_decision_orphaned_memory_id_parses():
    payload = {
        "id": 9,
        "memoryId": None,
        "tenantId": "default",
        "decisionText": "memory was forgotten",
        "status": "active",
        "createdAt": "2026-05-28T12:00:00Z",
    }
    d = Decision.model_validate(payload)
    assert d.memory_id is None
    assert d.decision_text == "memory was forgotten"


def test_hippo_async_has_decision_methods():
    assert hasattr(Hippo, "decide")
    assert hasattr(Hippo, "supersede_decision")
    assert hasattr(Hippo, "close_decision")
    assert hasattr(Hippo, "list_decisions")
    assert hasattr(Hippo, "get_decision")


def test_hippo_sync_has_decision_methods():
    assert hasattr(HippoSync, "decide")
    assert hasattr(HippoSync, "supersede_decision")
    assert hasattr(HippoSync, "close_decision")
    assert hasattr(HippoSync, "list_decisions")
    assert hasattr(HippoSync, "get_decision")
