"""Pydantic v2 models for hippo-memory HTTP request/response shapes.

All models inherit from a private ``_Base`` with these conventions:

- ``populate_by_name=True`` + ``alias_generator=to_camel`` -> server returns
  camelCase JSON (e.g. ``tenantId``) while Python users see snake_case
  attribute names (``tenant_id``).
- ``extra="allow"`` -> server adding new fields in a future release doesn't
  break the SDK. The trade-off: a typo in test JSON (e.g. ``tneant_id``)
  silently ends up in ``model_extra`` rather than raising ValidationError.
  Forward-compat is worth more than typo-strictness for an evolving server.

Author judgment call: v0.1 types every documented response shape. Less-used
shapes (drill, archive, supersede, promote, forget) use ``dict[str, Any]``
on their inner data fields when the precise structure is implementation-
detail; tighter types can land in v0.2 once usage patterns surface.
"""

from __future__ import annotations
from typing import Any
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


__all__ = [
    "HealthInfo",
    "MemoryEnvelope",
    "RecallEntry",
    "RecallResult",
    "RecallSuppressionSummary",
    "PlanningFallacyHint",
    "AnchoringHint",
    "ContextEntry",
    "ContextResult",
    "OutcomeResult",
    "SleepResult",
    "DrillResult",
    "ArchiveResult",
    "SupersedeResult",
    "PromoteResult",
    "ForgetResult",
    "AssembleResult",
    "AuthCreated",
    "AuthKey",
    "AuthRevoked",
    "AuditEvent",
    "Decision",
    "Incident",
    "Prediction",
    "PredictionBaserate",
    "HippoError",
]


class _Base(BaseModel):
    """Shared model config: camelCase wire / snake_case Python; forward-compat extra fields."""

    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=to_camel,
        extra="allow",
    )


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------


class HealthInfo(_Base):
    ok: bool
    version: str
    started_at: str
    pid: int


# ---------------------------------------------------------------------------
# /v1/memories (POST = remember, GET = recall)
# ---------------------------------------------------------------------------


class MemoryEnvelope(_Base):
    """Memory envelope returned by remember + recall + context.

    Mirrors the server's MemoryEntry / RememberResult shape. POST /v1/memories
    returns a slim envelope (id + kind + tenant_id only); recall and context
    return the full entry. ALL fields except ``id`` are optional to handle
    both shapes with one model.
    """

    id: str
    tenant_id: str | None = None
    content: str | None = None
    kind: str | None = None
    layer: str | None = None
    strength: float | None = None
    confidence: str | None = None
    tags: list[str] = Field(default_factory=list)
    scope: str | None = None
    owner: str | None = None
    artifact_ref: str | None = None
    created: str | None = None
    pinned: bool | None = None
    superseded_by: str | None = None


class RecallEntry(_Base):
    """One result from /v1/memories?q=...

    Server returns the full MemoryEntry shape per result; ``score`` is added
    by the recall scorer. Many fields are optional or have server-side
    defaults; ``extra="allow"`` catches anything not explicitly modeled.
    """

    id: str
    content: str | None = None
    score: float | None = None
    tokens: int | None = None
    layer: str | None = None
    tags: list[str] = Field(default_factory=list)
    confidence: str | None = None
    strength: float | None = None
    is_global: bool | None = None
    is_fresh_tail: bool | None = None


class RecallSuppressionSummary(_Base):
    """v1.12.13 / C5 — WYSIATI cutoff transparency.

    Surfaces what the recall pipeline excluded from ``results[]`` so the
    calling agent does not treat the cutoff as the full picture (Kahneman's
    "What You See Is All There Is" failure mode, TFAS ch. 7).

    Counters are honest per-path reports, NOT normalised cross-pipeline
    numbers. api.recall, cmdRecall (CLI), and MCP hippo_recall each populate
    this with their own pipeline state. See the server-side TS interface
    ``RecallSuppressionSummary`` for per-pipeline field semantics.

    All fields default to 0; the server-side ``buildSuppressionSummary``
    helper always populates them, but defaults make this back-compatible
    with hand-constructed test fixtures.
    """

    total_candidates: int = 0
    dropped_pre_rank: int = 0
    dropped_by_budget: int = 0
    summary_substitutions_added: int = 0
    fresh_tail_added: int = 0
    suppressed_by_interference: int = 0


class AnchoringHint(_Base):
    """v0.33 / J1 anchoring detector (recall-recurrence) — hint surfaced on
    RecallResult when the per-(tenant, session) recall history shows
    either R1 (same query phrasing returning same top-1 within recent
    window) or R2 (same memory wins top-1 across >=3 distinct queries).

    Wire shape matches src/recall-history.ts ``AnchoringHint`` (camelCase
    via ``_Base.alias_generator=to_camel``). Disabled server-side by
    setting ``HIPPO_ANCHORING=off``.
    """

    # 'query_repeat' | 'memory_dominance'; widened to str for forward-compat
    # (same lesson as PlanningFallacyHint.source — never dispatch on this
    # field for control flow; future server may emit new reasons).
    reason: str
    """The memory id that is anchoring the agent's reasoning."""
    memory_id: str
    """For 'memory_dominance': how many distinct queries in the recent
    window had this memory as top-1. Always >= 3 when emitted."""
    query_count: int | None = None
    """Human-readable summary surfaced to the agent."""
    summary: str
    # Discriminator for hint origin. Current v1 server emits 'j1-recurrence';
    # future variants accepted as plain strings (same forward-compat lesson
    # as PlanningFallacyHint.source).
    source: str = "j1-recurrence"


class AvailabilityHint(_Base):
    """v1.13.x / J2 availability/recency-bias detector - hint surfaced on
    RecallResult when the returned top-K is recency-dominated while
    substantially older relevant matches in the same candidate pool were
    passed over (Tversky-Kahneman availability heuristic).

    Soft warning ONLY: never filters, reorders, or suppresses a result.
    Wire shape matches src/availability.ts ``AvailabilityHint`` (camelCase
    via ``_Base.alias_generator=to_camel``). Disabled server-side by setting
    ``HIPPO_AVAILABILITY=off``.
    """

    # Count of returned top-K entries created within the recency window.
    recent_count: int
    # Total returned top-K size considered (after dropping unparseable rows).
    returned_count: int
    # recent_count / returned_count, in [0, 1].
    recent_fraction: float
    # Median age in days of the returned top-K.
    top_k_median_age_days: float
    # Median age in days of the matched candidate pool it was drawn from.
    pool_median_age_days: float
    # Count of pool entries older than the top-K median age that were NOT
    # returned (older relevant matches passed over).
    older_candidates_passed_over: int
    # Human-readable summary surfaced to the agent.
    summary: str
    # Discriminator for hint origin. Current v1 server emits 'j2-recency';
    # future variants accepted as plain strings (same forward-compat lesson
    # as PlanningFallacyHint.source / AnchoringHint.source).
    source: str = "j2-recency"


class PlanningFallacyHint(_Base):
    """v0.32 / J3.2 — auto-injected planning-fallacy hint surfaced on
    RecallResult when the recall query carries a forward-prediction phrase
    AND the closest matching prediction class has closed historical data.

    Wire shape matches src/api.ts ``PlanningFallacyHint`` (camelCase via
    ``_Base.alias_generator=to_camel``). Disabled server-side by setting
    ``HIPPO_AUTODEBIAS=off``.
    """

    class_tag: str
    """Verbatim PredictionBaserate.summary, e.g.
    'Last 5 estimates in class migration-effort averaged 2.10x actual (MAE 1.40).'"""
    baserate_summary: str
    # Discriminator for hint origin. Current v1 server emits 'j3.2-auto';
    # future variants (e.g. 'j3.2-auto-v2', 'j3.3-auto' once embedding
    # fallback ships) are accepted as plain strings to honour the SDK's
    # forward-compat promise (see _Base docstring: "server adding new
    # fields in a future release doesn't break the SDK"). Pydantic
    # ``extra='allow'`` relaxes unknown FIELDS but does NOT relax Literal
    # validation, so typing this as Literal would raise ValidationError
    # mid-recall when a future server tightens the enum. Independent-
    # review-critic round 1 catch.
    source: str
    """Regex match snippet that triggered detection. Lets the calling agent
    see WHY the hint appeared and self-correct if detection misfires."""
    detected_phrase: str
    n_closed: int
    """Null only when every closed-row in the class had estimate_value=0."""
    mean_ratio: float | None = None


class PlanningFallacyWatching(_Base):
    """v1.13.4 / J3.2 follow-up — "watching" variant surfaced on
    RecallResult when the forward-claim regex matched but no
    PlanningFallacyHint baserate could be produced. Mutually exclusive
    with PlanningFallacyHint: at most one of the two is set per recall.

    The pre-v1.13.4 silent paths (no class match, tiebreak) were the
    dominant J3.2 failure mode — natural-language queries carrying
    forward-claim phrases often share no non-stopword tokens with any
    prediction class tag, so hippo emitted nothing despite the regex
    match. The watching variant surfaces the detection event plus a
    one-line suggestion so the agent can either re-tag the prediction
    or pass the suggestion through to the user.

    Wire shape matches src/api.ts ``PlanningFallacyWatching`` (camelCase
    via ``_Base.alias_generator=to_camel``). Disabled server-side by
    setting ``HIPPO_AUTODEBIAS=off``.
    """

    """The forward-claim phrase the detector matched (verbatim regex match)."""
    detected_phrase: str
    # 'no_class_match' | 'tiebreak'; widened to str for forward-compat
    # (same lesson as PlanningFallacyHint.source — never dispatch on this
    # field for control flow; future server may emit new reasons such as
    # 'embedding_fallback_failed' once J3.3 ships).
    reason: str
    """One-line agent-facing suggestion for how the user can give hippo
    enough signal to produce a baserate next time (e.g. tag a class)."""
    suggestion: str


class RecallResult(_Base):
    results: list[RecallEntry]
    total: int | None = None
    tokens: int | None = None
    # v1.12.13 / C5 — WYSIATI cutoff transparency. Optional for back-compat
    # with pre-v1.12.13 server payloads (field omitted is fine). When
    # present, gives the calling agent a per-pipeline breakdown of what was
    # excluded from results[] and why. Wire alias `suppressionSummary` is
    # generated automatically by _Base.alias_generator=to_camel.
    suppression_summary: RecallSuppressionSummary | None = None
    # v0.32 / J3.2 — auto-injected reference-class baserate hint when the
    # query carries a forward-prediction phrase. Absent (None) when env
    # disabled (HIPPO_AUTODEBIAS=off), no forward-claim detected, no class
    # resolved, ambiguous tiebreak, or no closed data in resolved class.
    planning_fallacy_hint: PlanningFallacyHint | None = None
    # v1.13.4 / J3.2 follow-up — "watching" variant surfaced when the
    # forward-claim regex matched but no PlanningFallacyHint could be
    # produced (no class match, or tiebreak). Mutually exclusive with
    # planning_fallacy_hint above. Closes the v1.13.4-era silent-failure
    # path where natural-language forward-claims without overlapping
    # class tokens emitted nothing despite the regex match.
    planning_fallacy_watching: PlanningFallacyWatching | None = None
    # v0.33 / J1 — recall-recurrence anchoring hint. Absent (None) when
    # env disabled (HIPPO_ANCHORING=off), no sessionId, no R1/R2 pattern
    # detected, or pipeline does not run J1 detection. On CLI-routed
    # call paths this is always None (CLI computes its own hint
    # separately); non-None on direct SDK / HTTP-routed invocations.
    anchoring_hint: AnchoringHint | None = None
    # v1.13.x / J2 — availability/recency-bias hint. Absent (None) when env
    # disabled (HIPPO_AVAILABILITY=off), the returned slice is not
    # recency-dominated, the pool is not older than the returned slice, or
    # fewer than the threshold of older candidates were passed over. Per-
    # pipeline: each pipeline computes its own hint against its own top-K.
    availability_hint: AvailabilityHint | None = None


# ---------------------------------------------------------------------------
# /v1/context (Episode B)
# ---------------------------------------------------------------------------


class ContextEntry(_Base):
    """One entry inside a ContextResult.

    ``entry`` contains the full MemoryEntry shape (typed as MemoryEnvelope
    here since the wire shape matches). For SDK consumers who want the
    leaner CLI shape (id + score + strength + tags + confidence + content +
    global only), call :meth:`projected` — added v0.2.0.
    """

    entry: MemoryEnvelope
    score: float
    tokens: int
    is_global: bool | None = None
    is_fresh_tail: bool | None = None

    def projected(self) -> dict[str, Any]:
        """v0.2.0: project the full entry surface to the CLI's narrower shape.

        Mirrors `hippo context --format json` per-row output (src/cli.ts
        printContextMarkdown json branch). Returned dict shape:

        - ``id``: memory id
        - ``score``: scorer score (float)
        - ``strength``: decay-adjusted strength (float | None)
        - ``tags``: list[str]
        - ``confidence``: 'verified' | 'observed' | 'inferred' | 'stale' | None
        - ``content``: memory text
        - ``global``: bool (true when sourced from global store)

        Use this when piping SDK results into LLM context or CLI-shaped
        downstream consumers. The full ``entry`` shape stays available on
        the model for callers who need it (e.g. for ``superseded_by``,
        ``embeddings``, ``goal_associations``).
        """
        return {
            "id": self.entry.id,
            "score": self.score,
            "strength": self.entry.strength,
            "tags": self.entry.tags,
            "confidence": self.entry.confidence,
            "content": self.entry.content,
            "global": bool(self.is_global),
        }


class ContextResult(_Base):
    entries: list[ContextEntry]
    tokens: int
    # Snapshot / handoff / events are CLI-side concepts mirrored on the wire.
    # Typed as dict[str, Any] to avoid a deep model for these v0.1; tighten in v0.2.
    active_snapshot: dict[str, Any] | None = None
    session_handoff: dict[str, Any] | None = None
    recent_events: list[dict[str, Any]] | None = None


# ---------------------------------------------------------------------------
# /v1/outcome (Episode B)
# ---------------------------------------------------------------------------


class OutcomeResult(_Base):
    """Returned by POST /v1/outcome.

    - ids-provided path: ``{applied: N}`` (no ``ids`` field).
    - last-recall path: ``{applied: N, ids: [...]}`` where ids is the
      tenant-filtered applied subset (v1.11.4 security guarantee).
    """

    applied: int
    ids: list[str] | None = None


# ---------------------------------------------------------------------------
# /v1/sleep (Episode B) - loopback-only on server side
# ---------------------------------------------------------------------------


class SleepResult(_Base):
    active: int
    removed: int
    merged_episodic: int
    new_semantic: int
    dry_run: bool
    deduped: dict[str, Any] | None = None
    audit: dict[str, Any] | None = None
    shared: int | None = None
    ambient: dict[str, Any] | None = None
    details: list[str] | None = None


# ---------------------------------------------------------------------------
# /v1/recall/drill/:id
# ---------------------------------------------------------------------------


class DrillResult(_Base):
    """Drill into a memory's DAG children.

    Shape mirrors api.drillDown's return: list of children + summary counts.
    Inner fields are typed loosely (dict[str, Any]) for v0.1; tighten in v0.2.
    """

    parent: dict[str, Any] | None = None
    children: list[dict[str, Any]] = Field(default_factory=list)
    total_children: int | None = None
    truncated: bool | None = None


# ---------------------------------------------------------------------------
# /v1/memories/:id/archive | supersede | promote, DELETE /v1/memories/:id
# ---------------------------------------------------------------------------


class ArchiveResult(_Base):
    ok: bool
    id: str
    archived_at: str | None = None
    reason: str | None = None


class SupersedeResult(_Base):
    ok: bool
    id: str
    superseded_by: str | None = None


class PromoteResult(_Base):
    ok: bool
    source_id: str | None = None
    global_id: str | None = None


class ForgetResult(_Base):
    ok: bool
    id: str


# ---------------------------------------------------------------------------
# /v1/sessions/:id/assemble (Phase 2 context engine)
# ---------------------------------------------------------------------------


class AssembleResult(_Base):
    """Phase 2 context-engine assembly.

    Shape is open for v0.1 (typed loosely). Phase 2 is still evolving;
    consumers can read the wire JSON via ``model_extra`` if needed.
    """

    session_id: str | None = None
    items: list[dict[str, Any]] = Field(default_factory=list)
    tokens: int | None = None


# ---------------------------------------------------------------------------
# /v1/auth/keys
# ---------------------------------------------------------------------------


class AuthCreated(_Base):
    """Returned by POST /v1/auth/keys. Plaintext lands ONCE.

    v0.2.0: field renamed ``key`` → ``plaintext`` to match the server wire
    shape (the v0.1 `key` field was a doc/test bug that no integration test
    exercised). Pre-v0.2.0 consumers reading ``result.key`` will see an
    AttributeError; switch to ``result.plaintext``.

    v1.12.3+ server populates ``role`` ('admin' | 'member'). Optional here
    for back-compat with hippo-memory server <1.12.3.
    """

    key_id: str
    plaintext: str  # plaintext key, displayed once on mint
    tenant_id: str | None = None
    label: str | None = None
    created_at: str | None = None
    role: str | None = None


class AuthKey(_Base):
    """Returned by GET /v1/auth/keys (no plaintext).

    v1.12.3+ server populates ``role`` ('admin' | 'member'). Optional here
    for back-compat with hippo-memory server <1.12.3.
    """

    key_id: str
    tenant_id: str | None = None
    label: str | None = None
    created_at: str | None = None
    last_used_at: str | None = None
    revoked_at: str | None = None
    role: str | None = None


class AuthRevoked(_Base):
    ok: bool
    key_id: str
    revoked_at: str | None = None


# ---------------------------------------------------------------------------
# /v1/audit
# ---------------------------------------------------------------------------


class AuditEvent(_Base):
    id: int | None = None
    tenant_id: str
    actor: str
    op: str
    target_id: str | None = None
    metadata: dict[str, Any] | None = None
    created_at: str | None = None


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# v0.31 / E2 — prediction first-class object
# (docs/plans/2026-05-26-e2-prediction-object.md)
# ---------------------------------------------------------------------------


class Prediction(_Base):
    """Prediction first-class object. Mirrors the TS Prediction interface
    in src/predictions.ts.

    Three closure states: ``open``, ``closed``, ``closed-unknown``. J3
    (reference-class / planning-fallacy detector) computes accuracy
    (clean vs regressed) from ``(estimate_value, actual_value)`` at query
    time; this model carries the raw numerics + the closure state, not
    the derived accuracy class.

    ``memory_id`` is nullable: ``ON DELETE SET NULL`` on the server side
    means memory deletion (forget / consolidate / archive) gracefully
    orphans the prediction. The prediction row survives with all fields
    populated; only the back-reference is lost.
    """

    id: int
    memory_id: str | None = None
    tenant_id: str
    class_tag: str
    claim_text: str
    estimate_value: float | None = None
    estimate_unit: str | None = None
    target_date: str | None = None
    actual_value: float | None = None
    closure_state: str = "open"
    closed_at: str | None = None
    closure_note: str | None = None
    created_at: str


# ---------------------------------------------------------------------------
# v0.31 / J3 — reference-class / planning-fallacy detector
# (docs/plans/2026-05-26-j3-baserate-detector.md)
# ---------------------------------------------------------------------------


class PredictionBaserate(_Base):
    """Base-rate stats for closed predictions in a class. Surfaces from
    `Hippo.get_prediction_baserate(class_tag)` / the `hippo_predict_baserate`
    MCP tool / `GET /v1/predictions/stats?class=X`.

    J3 (reference-class / planning-fallacy detector) returns this when the
    agent queries its past track record on forward-looking claims. Lovallo-
    Kahneman (2003) inside-vs-outside view.

    Numeric fields are None when ``n_closed = 0`` (or ``n_ratio_eligible = 0``
    for ratio fields). ``summary`` is empty when there are no closed
    predictions yet; callers should render "no data" messaging.
    """

    class_tag: str
    n_closed: int = 0
    n_ratio_eligible: int = 0
    mean_estimate: float | None = None
    mean_actual: float | None = None
    mean_ratio: float | None = None
    p50_ratio: float | None = None
    mae: float | None = None
    summary: str = ""


class Decision(_Base):
    """Decision first-class object. Mirrors the TS Decision interface in
    src/decisions.ts.

    Three statuses: ``active``, ``superseded`` (replaced by a newer decision;
    ``superseded_by`` points to the successor), and ``closed`` (retired with no
    successor). The decisions table is canonical, so an in-force decision stays
    ``active`` regardless of memory decay - this fixes the pre-promotion bug
    where decision-tagged memories decayed on a 90-day half-life while the
    decision was still in force.

    ``memory_id`` is nullable: ``ON DELETE SET NULL`` server-side means memory
    deletion (forget / consolidate / archive) gracefully orphans the decision
    row, which survives with all fields populated.
    """

    id: int
    memory_id: str | None = None
    tenant_id: str
    decision_text: str
    context: str | None = None
    status: str = "active"
    superseded_by: int | None = None
    superseded_at: str | None = None
    closed_at: str | None = None
    created_at: str


class Incident(_Base):
    """Incident first-class object. Mirrors the TS Incident interface in
    src/incidents.ts.

    An incident is a postmortem capsule: a recorded operational event with a
    lifecycle and optional linked receipts (the memories that are its
    evidence). Three statuses: ``open`` (active; default on create),
    ``resolved`` (a resolution was recorded in ``resolution_text`` /
    ``resolved_at``; the incident stays on record), and ``closed`` (retired;
    ``closed_at`` set, reachable from open or resolved). This is NOT decision's
    supersede - there is no ``superseded_by``.

    The incidents table is canonical, so an open incident stays ``open``
    regardless of memory decay. ``memory_id`` is nullable: ``ON DELETE SET
    NULL`` server-side means memory deletion (forget / consolidate / archive)
    gracefully orphans the incident row.

    ``linked_memory_ids`` is the linked-receipts list: memory ids validated
    against the same tenant on save.
    """

    id: int
    memory_id: str | None = None
    tenant_id: str
    incident_text: str
    context: str | None = None
    status: str = "open"
    resolution_text: str | None = None
    resolved_at: str | None = None
    closed_at: str | None = None
    linked_memory_ids: list[str] = Field(default_factory=list)
    created_at: str


class HippoError(Exception):
    """Raised on HTTP 4xx/5xx responses.

    Attributes:
        status_code: HTTP status (e.g. 400, 403, 404, 429).
        body: Parsed JSON body of the error response, if any.
    """

    def __init__(self, status_code: int, message: str, body: dict[str, Any] | None = None):
        super().__init__(f"{status_code}: {message}")
        self.status_code = status_code
        self.body = body
