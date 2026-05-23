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


class RecallResult(_Base):
    results: list[RecallEntry]
    total: int | None = None
    tokens: int | None = None


# ---------------------------------------------------------------------------
# /v1/context (Episode B)
# ---------------------------------------------------------------------------


class ContextEntry(_Base):
    """One entry inside a ContextResult.

    Note: ``entry`` contains the full MemoryEntry shape (typed as
    MemoryEnvelope here since the wire shape matches). Episode B's
    independent-review-critic flagged that the SDK exposes the full surface;
    a v0.2 ``projected()`` helper could mirror the CLI's narrower json
    projection. See TODOS.md.
    """

    entry: MemoryEnvelope
    score: float
    tokens: int
    is_global: bool | None = None
    is_fresh_tail: bool | None = None


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
    """Returned by POST /v1/auth/keys. Plaintext ``key`` lands ONCE."""

    key_id: str
    key: str  # plaintext, displayed once
    tenant_id: str | None = None
    label: str | None = None
    created_at: str | None = None


class AuthKey(_Base):
    """Returned by GET /v1/auth/keys (no plaintext)."""

    key_id: str
    tenant_id: str | None = None
    label: str | None = None
    created_at: str | None = None
    last_used_at: str | None = None
    revoked_at: str | None = None


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
