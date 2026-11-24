from __future__ import annotations

from hippo_memory import (
    HealthInfo, MemoryEnvelope, RecallEntry, RecallResult,
    RecallSuppressionSummary, PlanningFallacyHint, PlanningFallacyWatching, AnchoringHint,
    AvailabilityHint,
    ContextEntry, ContextResult, OutcomeResult, SleepResult,
    DrillResult, ArchiveResult, SupersedeResult, PromoteResult,
    ForgetResult, AssembleResult, AuthCreated, AuthKey, AuthRevoked,
    AuditEvent, HippoError,
)


def _roundtrip(model_cls, payload: dict) -> None:
    instance = model_cls.model_validate(payload)
    dumped = instance.model_dump(by_alias=True, exclude_unset=True)
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


def test_lead_in_parses_on_envelope_and_recall_entry_and_is_none_when_absent():
    led = {"id": "mem_a", "content": "Three times a week"}
    assert MemoryEnvelope.model_validate({**led, "leadIn": "user: How often?"}).lead_in == "user: How often?"
    assert RecallEntry.model_validate({**led, "leadIn": "user: How often?"}).lead_in == "user: How often?"
    assert MemoryEnvelope.model_validate(led).lead_in is None
    assert RecallEntry.model_validate(led).lead_in is None


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
    instance = OutcomeResult.model_validate({"applied": 2})
    assert instance.applied == 2
    assert instance.ids is None


def test_outcome_result_last_recall_path():
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
        "keyId": "hk_abc", "plaintext": "hk_abc.secret_body",
        "tenantId": "default", "label": "test-key", "createdAt": "2026-05-23T18:00:00Z",
        "role": "admin",
    })
    _roundtrip(AuthKey, {
        "keyId": "hk_abc", "tenantId": "default", "label": "test-key",
        "createdAt": "2026-05-23T18:00:00Z", "role": "admin",
    })
    _roundtrip(AuthRevoked, {"ok": True, "keyId": "hk_abc", "revokedAt": "2026-05-23T18:00:00Z"})


def test_audit_event_roundtrip():
    _roundtrip(AuditEvent, {
        "id": 1, "tenantId": "default", "actor": "localhost:cli",
        "op": "outcome", "targetId": "mem_x", "metadata": {"good": True},
        "createdAt": "2026-05-23T18:00:00Z",
    })


def test_extra_fields_allowed_forward_compat():
    instance = MemoryEnvelope.model_validate({
        "id": "mem_x", "content": "y", "tenantId": "default",
        "futureField": "value-the-sdk-doesnt-know",
    })
    assert instance.id == "mem_x"
    assert instance.model_extra.get("futureField") == "value-the-sdk-doesnt-know"


def test_hippo_error_carries_status_and_body():
    err = HippoError(400, "good is required", body={"error": "good is required"})
    assert err.status_code == 400
    assert err.body == {"error": "good is required"}
    assert "400" in str(err)
    assert "good is required" in str(err)


def test_recall_suppression_summary_roundtrip():
    payload = {
        "totalCandidates": 47,
        "droppedPreRank": 2,
        "droppedByBudget": 38,
        "summarySubstitutionsAdded": 1,
        "freshTailAdded": 4,
        "suppressedByInterference": 0,
    }
    _roundtrip(RecallSuppressionSummary, payload)


def test_recall_suppression_summary_defaults_to_zero():
    s = RecallSuppressionSummary()
    assert s.total_candidates == 0
    assert s.dropped_pre_rank == 0
    assert s.dropped_by_budget == 0
    assert s.summary_substitutions_added == 0
    assert s.fresh_tail_added == 0
    assert s.suppressed_by_interference == 0


def test_recall_result_with_suppression_summary():
    payload = {
        "results": [{"id": "mem_a", "content": "a", "score": 0.9, "tokens": 5}],
        "total": 1,
        "tokens": 5,
        "suppressionSummary": {
            "totalCandidates": 47,
            "droppedPreRank": 2,
            "droppedByBudget": 41,
            "summarySubstitutionsAdded": 0,
            "freshTailAdded": 0,
            "suppressedByInterference": 0,
        },
    }
    instance = RecallResult.model_validate(payload)
    assert instance.suppression_summary is not None
    assert instance.suppression_summary.total_candidates == 47
    assert instance.suppression_summary.dropped_by_budget == 41


def test_recall_result_back_compat_without_suppression_summary():
    payload_pre_v1_12_13 = {
        "results": [{"id": "mem_a", "content": "a", "score": 0.9, "tokens": 5}],
        "total": 1,
        "tokens": 5,
    }
    instance = RecallResult.model_validate(payload_pre_v1_12_13)
    assert instance.suppression_summary is None
    assert instance.results[0].id == "mem_a"
    assert instance.total == 1
    assert instance.tokens == 5


def test_planning_fallacy_hint_roundtrip():
    _roundtrip(PlanningFallacyHint, {
        "classTag": "migration-effort",
        "baserateSummary": "Last 3 estimates in class migration-effort averaged 2.00x actual (MAE 2.00).",
        "source": "j3.2-auto",
        "detectedPhrase": "will take",
        "nClosed": 3,
        "meanRatio": 2.0,
    })


def test_planning_fallacy_hint_mean_ratio_null_allowed():
    hint = PlanningFallacyHint.model_validate({
        "classTag": "zero-estimates",
        "baserateSummary": "Last 1 estimate in class zero-estimates no ratio-eligible rows (all estimates were 0) (MAE 3.00).",
        "source": "j3.2-auto",
        "detectedPhrase": "estimate 0",
        "nClosed": 1,
        "meanRatio": None,
    })
    assert hint.mean_ratio is None
    assert hint.n_closed == 1


def test_recall_result_with_planning_fallacy_hint():
    payload = {
        "results": [{"id": "mem_a", "content": "a", "score": 0.9, "tokens": 5}],
        "total": 1,
        "tokens": 5,
        "planningFallacyHint": {
            "classTag": "migration-effort",
            "baserateSummary": "Last 3 estimates in class migration-effort averaged 2.00x actual (MAE 2.00).",
            "source": "j3.2-auto",
            "detectedPhrase": "will take",
            "nClosed": 3,
            "meanRatio": 2.0,
        },
    }
    instance = RecallResult.model_validate(payload)
    assert instance.planning_fallacy_hint is not None
    assert instance.planning_fallacy_hint.class_tag == "migration-effort"
    assert instance.planning_fallacy_hint.source == "j3.2-auto"
    assert instance.planning_fallacy_hint.n_closed == 3
    assert instance.planning_fallacy_hint.mean_ratio == 2.0


def test_recall_result_without_planning_fallacy_hint_defaults_to_none():
    payload_no_hint = {
        "results": [{"id": "mem_a", "content": "a", "score": 0.9, "tokens": 5}],
        "total": 1,
        "tokens": 5,
    }
    instance = RecallResult.model_validate(payload_no_hint)
    assert instance.planning_fallacy_hint is None
    assert instance.planning_fallacy_watching is None


def test_planning_fallacy_watching_roundtrip_no_class_match():
    _roundtrip(PlanningFallacyWatching, {
        "detectedPhrase": "will take 3 days",
        "reason": "no_class_match",
        "suggestion": "No matching prediction class for this forward-claim. Tag your prediction with `hippo predict --class <name>` to start tracking this class.",
    })


def test_planning_fallacy_watching_roundtrip_tiebreak():
    _roundtrip(PlanningFallacyWatching, {
        "detectedPhrase": "ship by Friday",
        "reason": "tiebreak",
        "suggestion": "Multiple prediction classes tied on this query. Refine the query or rename overlapping classes to break the tie.",
    })


def test_planning_fallacy_watching_unknown_reason_forward_compat():
    watching = PlanningFallacyWatching.model_validate({
        "detectedPhrase": "will land in 2 weeks",
        "reason": "embedding_fallback_failed",
        "suggestion": "...",
    })
    assert watching.reason == "embedding_fallback_failed"


def test_recall_result_with_planning_fallacy_watching():
    payload = {
        "results": [{"id": "mem_a", "content": "a", "score": 0.9, "tokens": 5}],
        "total": 1,
        "tokens": 5,
        "planningFallacyWatching": {
            "detectedPhrase": "will take 3 days",
            "reason": "no_class_match",
            "suggestion": "Tag your prediction with `hippo predict --class <name>`.",
        },
    }
    instance = RecallResult.model_validate(payload)
    assert instance.planning_fallacy_watching is not None
    assert instance.planning_fallacy_watching.reason == "no_class_match"
    assert instance.planning_fallacy_watching.detected_phrase == "will take 3 days"
    assert "hippo predict --class" in instance.planning_fallacy_watching.suggestion
    assert instance.planning_fallacy_hint is None


def test_anchoring_hint_roundtrip_memory_dominance():
    _roundtrip(AnchoringHint, {
        "reason": "memory_dominance",
        "memoryId": "mem_abc",
        "queryCount": 4,
        "summary": "Memory mem_abc has been the top result for 4 distinct queries.",
        "source": "j1-recurrence",
    })


def test_anchoring_hint_roundtrip_query_repeat_no_query_count():
    hint = AnchoringHint.model_validate({
        "reason": "query_repeat",
        "memoryId": "mem_xyz",
        "summary": "Same query phrasing returned same top result.",
        "source": "j1-recurrence",
    })
    assert hint.reason == "query_repeat"
    assert hint.query_count is None


def test_recall_result_with_anchoring_hint():
    payload = {
        "results": [{"id": "mem_a", "content": "a", "score": 0.9, "tokens": 5}],
        "total": 1,
        "tokens": 5,
        "anchoringHint": {
            "reason": "memory_dominance",
            "memoryId": "mem_a",
            "queryCount": 3,
            "summary": "Memory mem_a anchors your reasoning.",
            "source": "j1-recurrence",
        },
    }
    instance = RecallResult.model_validate(payload)
    assert instance.anchoring_hint is not None
    assert instance.anchoring_hint.memory_id == "mem_a"
    assert instance.anchoring_hint.query_count == 3


def test_recall_result_without_anchoring_hint_defaults_to_none():
    payload = {
        "results": [{"id": "mem_a", "content": "a", "score": 0.9, "tokens": 5}],
        "total": 1,
        "tokens": 5,
    }
    instance = RecallResult.model_validate(payload)
    assert instance.anchoring_hint is None


def test_anchoring_hint_source_accepts_future_variants():
    for future_source in ("j1-recurrence-v2", "j1-embedding", "j8-composition"):
        hint = AnchoringHint.model_validate({
            "reason": "memory_dominance",
            "memoryId": "mem_x",
            "summary": "...",
            "source": future_source,
        })
        assert hint.source == future_source


def test_planning_fallacy_hint_source_accepts_future_variants():
    for future_source in ("j3.2-auto-v2", "j3.3-auto", "j4-auto", "manual-override"):
        hint = PlanningFallacyHint.model_validate({
            "classTag": "migration-effort",
            "baserateSummary": "Last 3 estimates in class migration-effort averaged 2.00x actual.",
            "source": future_source,
            "detectedPhrase": "will take",
            "nClosed": 3,
            "meanRatio": 2.0,
        })
        assert hint.source == future_source


def test_availability_hint_roundtrip():
    _roundtrip(AvailabilityHint, {
        "recentCount": 4,
        "returnedCount": 5,
        "recentFraction": 0.8,
        "topKMedianAgeDays": 0.3,
        "poolMedianAgeDays": 60.0,
        "olderCandidatesPassedOver": 10,
        "summary": "Availability bias risk: 4 of 5 returned results are recent.",
        "source": "j2-recency",
    })


def test_availability_hint_camelcase_maps_to_snake_attrs():
    hint = AvailabilityHint.model_validate({
        "recentCount": 4,
        "returnedCount": 5,
        "recentFraction": 0.8,
        "topKMedianAgeDays": 0.3,
        "poolMedianAgeDays": 60.0,
        "olderCandidatesPassedOver": 10,
        "summary": "Availability bias risk.",
        "source": "j2-recency",
    })
    assert hint.recent_count == 4
    assert hint.returned_count == 5
    assert hint.recent_fraction == 0.8
    assert hint.top_k_median_age_days == 0.3
    assert hint.pool_median_age_days == 60.0
    assert hint.older_candidates_passed_over == 10
    assert hint.source == "j2-recency"


def test_recall_result_with_availability_hint():
    payload = {
        "results": [{"id": "mem_a", "content": "a", "score": 0.9, "tokens": 5}],
        "total": 1,
        "tokens": 5,
        "availabilityHint": {
            "recentCount": 4,
            "returnedCount": 5,
            "recentFraction": 0.8,
            "topKMedianAgeDays": 0.3,
            "poolMedianAgeDays": 60.0,
            "olderCandidatesPassedOver": 10,
            "summary": "Availability bias risk.",
            "source": "j2-recency",
        },
    }
    instance = RecallResult.model_validate(payload)
    assert instance.availability_hint is not None
    assert instance.availability_hint.recent_count == 4
    assert instance.availability_hint.older_candidates_passed_over == 10


def test_recall_result_without_availability_hint_defaults_to_none():
    payload = {
        "results": [{"id": "mem_a", "content": "a", "score": 0.9, "tokens": 5}],
        "total": 1,
        "tokens": 5,
    }
    instance = RecallResult.model_validate(payload)
    assert instance.availability_hint is None


def test_recall_result_all_track_j_hints_coexist():
    payload = {
        "results": [{"id": "mem_a", "content": "a", "score": 0.9, "tokens": 5}],
        "total": 1,
        "tokens": 5,
        "anchoringHint": {
            "reason": "memory_dominance",
            "memoryId": "mem_a",
            "queryCount": 3,
            "summary": "Memory mem_a anchors your reasoning.",
            "source": "j1-recurrence",
        },
        "planningFallacyHint": {
            "classTag": "migration-effort",
            "baserateSummary": "Last 3 estimates averaged 2.00x actual.",
            "source": "j3.2-auto",
            "detectedPhrase": "will take",
            "nClosed": 3,
            "meanRatio": 2.0,
        },
        "availabilityHint": {
            "recentCount": 4,
            "returnedCount": 5,
            "recentFraction": 0.8,
            "topKMedianAgeDays": 0.3,
            "poolMedianAgeDays": 60.0,
            "olderCandidatesPassedOver": 10,
            "summary": "Availability bias risk.",
            "source": "j2-recency",
        },
    }
    instance = RecallResult.model_validate(payload)
    assert instance.anchoring_hint is not None
    assert instance.planning_fallacy_hint is not None
    assert instance.availability_hint is not None
    assert instance.availability_hint.recent_fraction == 0.8


def test_availability_hint_source_accepts_future_variants():
    for future_source in ("j2-recency-v2", "j2-embedding", "j8-composition"):
        hint = AvailabilityHint.model_validate({
            "recentCount": 4,
            "returnedCount": 5,
            "recentFraction": 0.8,
            "topKMedianAgeDays": 0.3,
            "poolMedianAgeDays": 60.0,
            "olderCandidatesPassedOver": 10,
            "summary": "...",
            "source": future_source,
        })
        assert hint.source == future_source
