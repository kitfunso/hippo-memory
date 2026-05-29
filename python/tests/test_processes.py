"""E2 process first-class object - Python SDK Pydantic tests.

Docs: docs/plans/2026-05-29-e2-process-object.md

Covers:
1. Process model round-trips wire camelCase <-> Python snake_case
2. Defaults: status='active', version=1, optional fields None, steps=[]
3. Back-compat: server response missing optional fields parses cleanly
4. ON DELETE SET NULL: memory_id wire null parses to None
5. SDK methods exist on Hippo + HippoSync (shape only; no server roundtrip)
"""

from __future__ import annotations

from hippo_memory import (
    Hippo,
    HippoSync,
    Process,
)


def _roundtrip(model_cls, payload: dict) -> None:
    """Validate -> dump -> compare. Mirrors test_incidents.py pattern."""
    instance = model_cls.model_validate(payload)
    dumped = instance.model_dump(by_alias=True, exclude_unset=True)
    for key in payload:
        assert key in dumped, f"{model_cls.__name__}: key '{key}' lost in round-trip"


def test_process_roundtrip_full_shape():
    """Server emits camelCase wire keys (processName etc.); Python sees
    snake_case attribute names via _Base.alias_generator=to_camel."""
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
    """Hand-construct without optional fields; status defaults to 'active',
    version to 1, nullable fields to None, steps to []."""
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
    """Server response from a build that omits the new optional fields
    still parses (e.g. a process with no description)."""
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
    """After ON DELETE SET NULL on the server, memory_id wire value is JSON
    null. Pydantic must parse it as Python None, not reject."""
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
    """Shape-only check: Hippo (async) exposes the 5 process methods."""
    assert hasattr(Hippo, "new_process")
    assert hasattr(Hippo, "supersede_process")
    assert hasattr(Hippo, "close_process")
    assert hasattr(Hippo, "list_processes")
    assert hasattr(Hippo, "get_process")


def test_hippo_sync_has_process_methods():
    """Shape-only check: HippoSync exposes the same 5 process methods."""
    assert hasattr(HippoSync, "new_process")
    assert hasattr(HippoSync, "supersede_process")
    assert hasattr(HippoSync, "close_process")
    assert hasattr(HippoSync, "list_processes")
    assert hasattr(HippoSync, "get_process")
