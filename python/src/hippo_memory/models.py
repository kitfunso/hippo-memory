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
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


__all__ = [
    "HealthInfo",
    "MemoryEnvelope",
    "RecallEntry",
    "RecallResult",
    "RecallSuppressionSummary",
    "PlanningFallacyHint",
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
    source: Literal["j3.2-auto"]
    """Regex match snippet that triggered detection. Lets the calling agent
    see WHY the hint appeared and self-correct if detection misfires."""
    detected_phrase: str
    n_closed: int
    """Null only when every closed-row in the class had estimate_value=0."""
    mean_ratio: float | None = None


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
