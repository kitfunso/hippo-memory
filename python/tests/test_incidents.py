"""E2 incident first-class object - Python SDK Pydantic tests.

Docs: docs/plans/2026-05-29-e2-incident-object.md

Covers:
1. Incident model round-trips wire camelCase <-> Python snake_case
2. Defaults: status='open', optional fields default to None, linked_memory_ids=[]
3. Back-compat: server response missing optional fields parses cleanly
4. ON DELETE SET NULL: memory_id wire null parses to None
5. SDK methods exist on Hippo + HippoSync (shape only; no server roundtrip)
"""

from __future__ import annotations

from hippo_memory import (
    Hippo,
    HippoSync,
    Incident,
)


def _roundtrip(model_cls, payload: dict) -> None:
    """Validate -> dump -> compare. Mirrors test_decisions.py pattern."""
    instance = model_cls.model_validate(payload)
    dumped = instance.model_dump(by_alias=True, exclude_unset=True)
    for key in payload:
        assert key in dumped, f"{model_cls.__name__}: key '{key}' lost in round-trip"


def test_incident_roundtrip_full_shape():
    """Server emits camelCase wire keys (incidentText etc.); Python sees
    snake_case attribute names via _Base.alias_generator=to_camel."""
    payload = {
        "id": 42,
        "memoryId": "sem_abc123",
        "tenantId": "default",
        "incidentText": "DB pool exhausted",
        "context": "spike at 14:00",
        "status": "resolved",
        "resolutionText": "restarted workers",
        "resolvedAt": "2026-05-29T10:00:00Z",
        "closedAt": None,
        "linkedMemoryIds": ["sem_ev1", "sem_ev2"],
        "createdAt": "2026-05-29T09:00:00Z",
    }
    _roundtrip(Incident, payload)


def test_incident_defaults_open_with_nulls():
    """Hand-construct without optional fields; status defaults to 'open',
    nullable fields default to None, linked_memory_ids defaults to []."""
    inc = Incident(
        id=1,
        tenant_id="default",
        incident_text="cron job silently failed",
        created_at="2026-05-29T12:00:00Z",
    )
    assert inc.status == "open"
    assert inc.memory_id is None
    assert inc.context is None
    assert inc.resolution_text is None
    assert inc.resolved_at is None
    assert inc.closed_at is None
    assert inc.linked_memory_ids == []


def test_incident_back_compat_missing_optional_fields():
    """Server response from a build that omits the new optional fields
    still parses (e.g. an incident with no context)."""
    payload = {
        "id": 7,
        "tenantId": "default",
        "incidentText": "API outage",
        "createdAt": "2026-05-29T12:00:00Z",
    }
    inc = Incident.model_validate(payload)
    assert inc.id == 7
    assert inc.tenant_id == "default"
    assert inc.incident_text == "API outage"
    assert inc.status == "open"
    assert inc.context is None
    assert inc.linked_memory_ids == []


def test_incident_orphaned_memory_id_parses():
    """After ON DELETE SET NULL on the server, memory_id wire value is JSON
    null. Pydantic must parse it as Python None, not reject."""
    payload = {
        "id": 9,
        "memoryId": None,
        "tenantId": "default",
        "incidentText": "memory was forgotten",
        "status": "open",
        "createdAt": "2026-05-29T12:00:00Z",
    }
    inc = Incident.model_validate(payload)
    assert inc.memory_id is None
    assert inc.incident_text == "memory was forgotten"


def test_hippo_async_has_incident_methods():
    """Shape-only check: Hippo (async) exposes the 5 incident methods."""
    assert hasattr(Hippo, "open_incident")
    assert hasattr(Hippo, "resolve_incident")
    assert hasattr(Hippo, "close_incident")
    assert hasattr(Hippo, "list_incidents")
    assert hasattr(Hippo, "get_incident")


def test_hippo_sync_has_incident_methods():
    """Shape-only check: HippoSync exposes the same 5 incident methods."""
    assert hasattr(HippoSync, "open_incident")
    assert hasattr(HippoSync, "resolve_incident")
    assert hasattr(HippoSync, "close_incident")
    assert hasattr(HippoSync, "list_incidents")
    assert hasattr(HippoSync, "get_incident")
