from __future__ import annotations

from hippo_memory import (
    Hippo,
    HippoSync,
    Process,
)


def _roundtrip(model_cls, payload: dict) -> None:
    instance = model_cls.model_validate(payload)
    dumped = instance.model_dump(by_alias=True, exclude_unset=True)
    for key in payload:
        assert key in dumped, f"{model_cls.__name__}: key '{key}' lost in round-trip"


def test_process_roundtrip_full_shape():
    payload = {
        "id": 42,
        "memoryId": "sem_abc123",
        "tenantId": "default",
        "processName": "Release",
        "description": "the npm release ritual",
        "steps": ["run tests", "bump version", "publish"],
        "version": 2,
        "status": "superseded",
        "supersededBy": 43,
        "supersededAt": "2026-05-29T10:00:00Z",
        "changeSummary": "added a rollback step",
        "closedAt": None,
        "createdAt": "2026-05-29T09:00:00Z",
    }
    _roundtrip(Process, payload)


def test_process_defaults_active_v1_with_nulls():
    proc = Process(
        id=1,
        tenant_id="default",
        process_name="Empty",
        created_at="2026-05-29T12:00:00Z",
    )
    assert proc.status == "active"
    assert proc.version == 1
    assert proc.memory_id is None
    assert proc.description is None
    assert proc.steps == []
    assert proc.superseded_by is None
    assert proc.superseded_at is None
    assert proc.change_summary is None
    assert proc.closed_at is None


def test_process_back_compat_missing_optional_fields():
    payload = {
        "id": 7,
        "tenantId": "default",
        "processName": "Onboarding",
        "createdAt": "2026-05-29T12:00:00Z",
    }
    proc = Process.model_validate(payload)
    assert proc.id == 7
    assert proc.tenant_id == "default"
    assert proc.process_name == "Onboarding"
    assert proc.status == "active"
    assert proc.version == 1
    assert proc.steps == []


def test_process_orphaned_memory_id_parses():
    payload = {
        "id": 9,
        "memoryId": None,
        "tenantId": "default",
        "processName": "memory was forgotten",
        "status": "active",
        "createdAt": "2026-05-29T12:00:00Z",
    }
    proc = Process.model_validate(payload)
    assert proc.memory_id is None
    assert proc.process_name == "memory was forgotten"


def test_hippo_async_has_process_methods():
    assert hasattr(Hippo, "new_process")
    assert hasattr(Hippo, "supersede_process")
    assert hasattr(Hippo, "close_process")
    assert hasattr(Hippo, "list_processes")
    assert hasattr(Hippo, "get_process")


def test_hippo_sync_has_process_methods():
    assert hasattr(HippoSync, "new_process")
    assert hasattr(HippoSync, "supersede_process")
    assert hasattr(HippoSync, "close_process")
    assert hasattr(HippoSync, "list_processes")
    assert hasattr(HippoSync, "get_process")
