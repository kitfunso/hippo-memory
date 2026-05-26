"""E2 prediction first-class object — Python SDK Pydantic tests.

Docs: docs/plans/2026-05-26-e2-prediction-object.md

Covers:
1. Prediction model round-trips wire camelCase ↔ Python snake_case
2. Back-compat: server response missing optional fields parses cleanly
3. Defaults: closure_state='open', all optional fields default to None
4. SDK methods exist on Hippo + HippoSync (shape only; no server roundtrip)
"""

from __future__ import annotations

from hippo_memory import (
    Hippo,
    HippoSync,
    Prediction,
    PredictionBaserate,
)


def _roundtrip(model_cls, payload: dict) -> None:
    """Validate -> dump -> compare. Mirrors test_models.py pattern."""
    instance = model_cls.model_validate(payload)
    dumped = instance.model_dump(by_alias=True, exclude_unset=True)
    for key in payload:
        assert key in dumped, f"{model_cls.__name__}: key '{key}' lost in round-trip"


def test_prediction_roundtrip_full_shape():
    """Server emits camelCase wire keys (classTag etc.); Python sees
    snake_case attribute names. _Base's alias_generator=to_camel +
    populate_by_name=True handle both directions."""
    payload = {
        "id": 42,
        "memoryId": "mem_abc123",
        "tenantId": "default",
        "classTag": "migration-effort",
        "claimText": "migration takes 2 days",
        "estimateValue": 2.0,
        "estimateUnit": "days",
        "targetDate": "2026-06-15",
        "actualValue": 5.0,
        "closureState": "closed",
        "closedAt": "2026-06-20T10:00:00Z",
        "closureNote": "had to backfill",
        "createdAt": "2026-06-10T09:00:00Z",
    }
    _roundtrip(Prediction, payload)


def test_prediction_defaults_to_open_with_nulls():
    """Hand-construct without optional fields; closure_state defaults to
    'open' and all nullable fields default to None."""
    pred = Prediction(
        id=1,
        tenant_id="default",
        class_tag="test",
        claim_text="some claim text",
        created_at="2026-05-26T12:00:00Z",
    )
    assert pred.closure_state == "open"
    assert pred.memory_id is None
    assert pred.estimate_value is None
    assert pred.estimate_unit is None
    assert pred.target_date is None
    assert pred.actual_value is None
    assert pred.closed_at is None
    assert pred.closure_note is None


def test_prediction_back_compat_missing_optional_fields():
    """Server response from a build that omits the new optional fields
    (e.g. a categorical prediction with no estimate) still parses."""
    payload = {
        "id": 7,
        "tenantId": "default",
        "classTag": "rollout-risk",
        "claimText": "low risk",
        "createdAt": "2026-05-26T12:00:00Z",
        # memoryId, estimateValue, estimateUnit, targetDate, actualValue,
        # closureState, closedAt, closureNote all omitted (categorical / open)
    }
    pred = Prediction.model_validate(payload)
    assert pred.id == 7
    assert pred.tenant_id == "default"
    assert pred.class_tag == "rollout-risk"
    assert pred.claim_text == "low risk"
    assert pred.estimate_value is None
    assert pred.closure_state == "open"


def test_prediction_orphaned_memory_id_parses():
    """After ON DELETE SET NULL on the server, memory_id wire value is
    JSON null. Pydantic must parse it as Python None, not reject."""
    payload = {
        "id": 9,
        "memoryId": None,
        "tenantId": "default",
        "classTag": "orphan-test",
        "claimText": "memory was forgotten",
        "createdAt": "2026-05-26T12:00:00Z",
    }
    pred = Prediction.model_validate(payload)
    assert pred.memory_id is None
    assert pred.claim_text == "memory was forgotten"


def test_hippo_async_has_prediction_methods():
    """Shape-only check: Hippo (async) exposes 4 prediction methods."""
    assert hasattr(Hippo, "predict")
    assert hasattr(Hippo, "predict_close")
    assert hasattr(Hippo, "list_predictions")
    assert hasattr(Hippo, "get_prediction")


def test_hippo_sync_has_prediction_methods():
    """Shape-only check: HippoSync exposes the same 4 prediction methods."""
    assert hasattr(HippoSync, "predict")
    assert hasattr(HippoSync, "predict_close")
    assert hasattr(HippoSync, "list_predictions")
    assert hasattr(HippoSync, "get_prediction")


# ---------------------------------------------------------------------------
# v0.31 / J3 — reference-class / planning-fallacy detector
# ---------------------------------------------------------------------------


def test_prediction_baserate_roundtrip_full_shape():
    """Server emits camelCase wire keys (classTag, nClosed, etc.); Python
    sees snake_case attribute names via _Base.alias_generator=to_camel."""
    payload = {
        "classTag": "migration-effort",
        "nClosed": 5,
        "nRatioEligible": 5,
        "meanEstimate": 2.4,
        "meanActual": 5.1,
        "meanRatio": 2.125,
        "p50Ratio": 2.0,
        "mae": 2.7,
        "summary": "Last 5 estimates in class migration-effort averaged 2.13x actual (MAE 2.70).",
    }
    _roundtrip(PredictionBaserate, payload)


def test_prediction_baserate_empty_class_defaults():
    """When n_closed=0 (no closed predictions yet), numeric fields default
    to None and summary is empty string."""
    br = PredictionBaserate(class_tag="empty")
    assert br.class_tag == "empty"
    assert br.n_closed == 0
    assert br.n_ratio_eligible == 0
    assert br.mean_estimate is None
    assert br.mean_actual is None
    assert br.mean_ratio is None
    assert br.p50_ratio is None
    assert br.mae is None
    assert br.summary == ""


def test_hippo_has_get_prediction_baserate():
    """Shape-only check: both Hippo + HippoSync expose get_prediction_baserate."""
    assert hasattr(Hippo, "get_prediction_baserate")
    assert hasattr(HippoSync, "get_prediction_baserate")
