"""E2 policy first-class object (bi-temporal-first) - Python SDK tests.

Docs: docs/plans/2026-05-30-e2-policy-object.md

Covers:
1. Policy model round-trips wire camelCase <-> Python snake_case
2. Defaults: status='active', version=1, valid_to=None, optionals None
3. Back-compat: response missing optional fields parses
4. ON DELETE SET NULL: memory_id wire null -> None
5. SDK methods exist on Hippo + HippoSync (6 each)
6. models.__all__ contains Policy (codex P3 carry-forward from the process episode)
"""

from __future__ import annotations

from hippo_memory import Hippo, HippoSync, Policy
import hippo_memory.models as models


def _roundtrip(model_cls, payload: dict) -> None:
    instance = model_cls.model_validate(payload)
    dumped = instance.model_dump(by_alias=True, exclude_unset=True)
    for key in payload:
        assert key in dumped, f"{model_cls.__name__}: key '{key}' lost in round-trip"


def test_policy_roundtrip_full_shape():
    payload = {
        "id": 42,
        "memoryId": "sem_abc123",
        "tenantId": "default",
        "policyName": "Retention",
        "policyText": "Delete logs after 90 days",
        "validFrom": "2026-01-01T00:00:00.000Z",
        "validTo": "2026-06-01T00:00:00.000Z",
        "version": 2,
        "status": "superseded",
        "supersededBy": 43,
        "supersededAt": "2026-05-30T10:00:00.000Z",
        "changeSummary": "tightened window",
        "closedAt": None,
        "createdAt": "2026-05-30T09:00:00.000Z",
    }
    _roundtrip(Policy, payload)


def test_policy_defaults_active_v1_open_ended():
    p = Policy(
        id=1,
        tenant_id="default",
        policy_name="P",
        policy_text="a rule",
        valid_from="2026-01-01T00:00:00.000Z",
        created_at="2026-05-30T12:00:00.000Z",
    )
    assert p.status == "active"
    assert p.version == 1
    assert p.valid_to is None
    assert p.memory_id is None
    assert p.superseded_by is None
    assert p.change_summary is None
    assert p.closed_at is None


def test_policy_back_compat_missing_optional_fields():
    payload = {
        "id": 7,
        "tenantId": "default",
        "policyName": "Onboarding",
        "policyText": "x",
        "validFrom": "2026-01-01T00:00:00.000Z",
        "createdAt": "2026-05-30T12:00:00.000Z",
    }
    p = Policy.model_validate(payload)
    assert p.id == 7
    assert p.status == "active"
    assert p.version == 1
    assert p.valid_to is None


def test_policy_orphaned_memory_id_parses():
    payload = {
        "id": 9,
        "memoryId": None,
        "tenantId": "default",
        "policyName": "x",
        "policyText": "y",
        "validFrom": "2026-01-01T00:00:00.000Z",
        "status": "active",
        "createdAt": "2026-05-30T12:00:00.000Z",
    }
    assert Policy.model_validate(payload).memory_id is None


def test_models_all_contains_policy():
    # codex P3 from the process episode: models.py __all__ must export the symbol.
    assert "Policy" in models.__all__


def test_hippo_async_has_policy_methods():
    for m in ("new_policy", "supersede_policy", "close_policy", "list_policies", "get_policy", "policies_asof"):
        assert hasattr(Hippo, m), f"Hippo missing {m}"


def test_hippo_sync_has_policy_methods():
    for m in ("new_policy", "supersede_policy", "close_policy", "list_policies", "get_policy", "policies_asof"):
        assert hasattr(HippoSync, m), f"HippoSync missing {m}"
