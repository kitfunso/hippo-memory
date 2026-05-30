"""E2 project_brief first-class object (repo-scoped / auto-refreshes) - SDK tests.

Docs: docs/plans/2026-05-30-e2-project-brief-object.md

Covers:
1. ProjectBrief model round-trips wire camelCase <-> Python snake_case
2. Defaults: status='active', version=1, optionals None
3. Back-compat: response missing optional fields parses
4. ON DELETE SET NULL: memory_id wire null -> None
5. SDK methods exist on Hippo + HippoSync (6 each, incl refresh_project_brief)
6. models.__all__ AND package __all__ contain ProjectBrief (codex P3 carry-forward)
"""

from __future__ import annotations

import hippo_memory
from hippo_memory import Hippo, HippoSync, ProjectBrief
import hippo_memory.models as models


def _roundtrip(model_cls, payload: dict) -> None:
    instance = model_cls.model_validate(payload)
    dumped = instance.model_dump(by_alias=True, exclude_unset=True)
    for key in payload:
        assert key in dumped, f"{model_cls.__name__}: key '{key}' lost in round-trip"


def test_project_brief_roundtrip_full_shape():
    payload = {
        "id": 42,
        "memoryId": "sem_abc123",
        "tenantId": "default",
        "repo": "hippo",
        "summary": "agent-memory library; E2 objects in progress",
        "version": 2,
        "status": "superseded",
        "supersededBy": 43,
        "supersededAt": "2026-05-30T10:00:00.000Z",
        "changeSummary": "auto-refresh from 5 receipt(s)",
        "closedAt": None,
        "createdAt": "2026-05-30T09:00:00.000Z",
    }
    _roundtrip(ProjectBrief, payload)


def test_project_brief_defaults_active_v1():
    b = ProjectBrief(
        id=1,
        tenant_id="default",
        repo="hippo",
        summary="the brief body",
        created_at="2026-05-30T12:00:00.000Z",
    )
    assert b.status == "active"
    assert b.version == 1
    assert b.memory_id is None
    assert b.superseded_by is None
    assert b.change_summary is None
    assert b.closed_at is None


def test_project_brief_back_compat_missing_optional_fields():
    payload = {
        "id": 7,
        "tenantId": "default",
        "repo": "r",
        "summary": "x",
        "createdAt": "2026-05-30T12:00:00.000Z",
    }
    b = ProjectBrief.model_validate(payload)
    assert b.id == 7
    assert b.status == "active"
    assert b.version == 1


def test_project_brief_orphaned_memory_id_parses():
    payload = {
        "id": 9,
        "memoryId": None,
        "tenantId": "default",
        "repo": "r",
        "summary": "y",
        "status": "active",
        "createdAt": "2026-05-30T12:00:00.000Z",
    }
    assert ProjectBrief.model_validate(payload).memory_id is None


def test_models_all_contains_project_brief():
    assert "ProjectBrief" in models.__all__
    assert "ProjectBrief" in hippo_memory.__all__


def test_hippo_async_has_project_brief_methods():
    for m in (
        "new_project_brief", "supersede_project_brief", "close_project_brief",
        "list_project_briefs", "get_project_brief", "refresh_project_brief",
    ):
        assert hasattr(Hippo, m), f"Hippo missing {m}"


def test_hippo_sync_has_project_brief_methods():
    for m in (
        "new_project_brief", "supersede_project_brief", "close_project_brief",
        "list_project_briefs", "get_project_brief", "refresh_project_brief",
    ):
        assert hasattr(HippoSync, m), f"HippoSync missing {m}"
