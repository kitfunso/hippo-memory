"""E2 skill first-class object (executable/exportable) - Python SDK tests.

Docs: docs/plans/2026-05-30-e2-skill-object.md

Covers:
1. Skill model round-trips wire camelCase <-> Python snake_case
2. Defaults: status='active', version=1, trigger=None, optionals None
3. Back-compat: response missing optional fields parses
4. ON DELETE SET NULL: memory_id wire null -> None
5. SDK methods exist on Hippo + HippoSync (6 each, incl export_skills)
6. models.__all__ contains Skill (codex P3 carry-forward)
"""

from __future__ import annotations

from hippo_memory import Hippo, HippoSync, Skill
import hippo_memory.models as models


def _roundtrip(model_cls, payload: dict) -> None:
    instance = model_cls.model_validate(payload)
    dumped = instance.model_dump(by_alias=True, exclude_unset=True)
    for key in payload:
        assert key in dumped, f"{model_cls.__name__}: key '{key}' lost in round-trip"


def test_skill_roundtrip_full_shape():
    payload = {
        "id": 42,
        "memoryId": "sem_abc123",
        "tenantId": "default",
        "skillName": "Run tests",
        "instructions": "npm test before every commit",
        "trigger": "before commit",
        "version": 2,
        "status": "superseded",
        "supersededBy": 43,
        "supersededAt": "2026-05-30T10:00:00.000Z",
        "changeSummary": "added coverage gate",
        "closedAt": None,
        "createdAt": "2026-05-30T09:00:00.000Z",
    }
    _roundtrip(Skill, payload)


def test_skill_defaults_active_v1_no_trigger():
    s = Skill(
        id=1,
        tenant_id="default",
        skill_name="S",
        instructions="do the thing",
        created_at="2026-05-30T12:00:00.000Z",
    )
    assert s.status == "active"
    assert s.version == 1
    assert s.trigger is None
    assert s.memory_id is None
    assert s.superseded_by is None
    assert s.change_summary is None
    assert s.closed_at is None


def test_skill_back_compat_missing_optional_fields():
    payload = {
        "id": 7,
        "tenantId": "default",
        "skillName": "Onboard",
        "instructions": "x",
        "createdAt": "2026-05-30T12:00:00.000Z",
    }
    s = Skill.model_validate(payload)
    assert s.id == 7
    assert s.status == "active"
    assert s.version == 1
    assert s.trigger is None


def test_skill_orphaned_memory_id_parses():
    payload = {
        "id": 9,
        "memoryId": None,
        "tenantId": "default",
        "skillName": "x",
        "instructions": "y",
        "status": "active",
        "createdAt": "2026-05-30T12:00:00.000Z",
    }
    assert Skill.model_validate(payload).memory_id is None


def test_models_all_contains_skill():
    assert "Skill" in models.__all__


def test_hippo_async_has_skill_methods():
    for m in ("new_skill", "supersede_skill", "close_skill", "list_skills", "get_skill", "export_skills"):
        assert hasattr(Hippo, m), f"Hippo missing {m}"


def test_hippo_sync_has_skill_methods():
    for m in ("new_skill", "supersede_skill", "close_skill", "list_skills", "get_skill", "export_skills"):
        assert hasattr(HippoSync, m), f"HippoSync missing {m}"
