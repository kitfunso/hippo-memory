"""E2 customer_note first-class object (entity-scoped) - Python SDK tests.

Docs: docs/plans/2026-06-01-e2-customer-note-object.md

Covers:
1. CustomerNote model round-trips wire camelCase <-> Python snake_case
2. Defaults: status='active', version=1, optionals None
3. Back-compat: response missing optional fields parses
4. ON DELETE SET NULL: memory_id wire null -> None
5. SDK methods exist on Hippo + HippoSync (5 each)
6. models.__all__ AND package __all__ contain CustomerNote (codex P3 carry-forward)
"""

from __future__ import annotations

import hippo_memory
from hippo_memory import Hippo, HippoSync, CustomerNote
import hippo_memory.models as models


def _roundtrip(model_cls, payload: dict) -> None:
    instance = model_cls.model_validate(payload)
    dumped = instance.model_dump(by_alias=True, exclude_unset=True)
    for key in payload:
        assert key in dumped, f"{model_cls.__name__}: key '{key}' lost in round-trip"


def test_customer_note_roundtrip_full_shape():
    payload = {
        "id": 42,
        "memoryId": "sem_abc123",
        "tenantId": "default",
        "customer": "Acme Corp",
        "note": "renewal call: wants SSO before Q3",
        "version": 2,
        "status": "superseded",
        "supersededBy": 43,
        "supersededAt": "2026-06-01T10:00:00.000Z",
        "changeSummary": "corrected the quarter",
        "closedAt": None,
        "createdAt": "2026-06-01T09:00:00.000Z",
    }
    _roundtrip(CustomerNote, payload)


def test_customer_note_defaults_active_v1():
    n = CustomerNote(
        id=1,
        tenant_id="default",
        customer="Acme",
        note="a note",
        created_at="2026-06-01T12:00:00.000Z",
    )
    assert n.status == "active"
    assert n.version == 1
    assert n.memory_id is None
    assert n.superseded_by is None
    assert n.change_summary is None
    assert n.closed_at is None


def test_customer_note_back_compat_missing_optional_fields():
    payload = {
        "id": 7,
        "tenantId": "default",
        "customer": "c",
        "note": "x",
        "createdAt": "2026-06-01T12:00:00.000Z",
    }
    n = CustomerNote.model_validate(payload)
    assert n.id == 7
    assert n.status == "active"
    assert n.version == 1


def test_customer_note_orphaned_memory_id_parses():
    payload = {
        "id": 9,
        "memoryId": None,
        "tenantId": "default",
        "customer": "c",
        "note": "y",
        "status": "active",
        "createdAt": "2026-06-01T12:00:00.000Z",
    }
    assert CustomerNote.model_validate(payload).memory_id is None


def test_models_all_contains_customer_note():
    assert "CustomerNote" in models.__all__
    assert "CustomerNote" in hippo_memory.__all__


def test_hippo_async_has_customer_note_methods():
    for m in (
        "new_customer_note", "supersede_customer_note", "close_customer_note",
        "list_customer_notes", "get_customer_note",
    ):
        assert hasattr(Hippo, m), f"Hippo missing {m}"


def test_hippo_sync_has_customer_note_methods():
    for m in (
        "new_customer_note", "supersede_customer_note", "close_customer_note",
        "list_customer_notes", "get_customer_note",
    ):
        assert hasattr(HippoSync, m), f"HippoSync missing {m}"
