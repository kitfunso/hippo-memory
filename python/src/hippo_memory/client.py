"""Async httpx client for hippo-memory HTTP API.

The main public class is :class:`Hippo`. Construct it pointing at a running
``hippo serve`` instance (loopback by default), then call any of the 14
endpoint methods. All methods are async.

Example::

    from hippo_memory import Hippo

    async with Hippo(base_url="http://127.0.0.1:3737") as client:
        mem = await client.remember(content="bug fix lesson", tags=["error"])
        results = await client.recall(q="bug fix")
        ctx = await client.get_context(budget=1500)
        await client.outcome(good=True)  # last-recall path
"""

from __future__ import annotations
from typing import Any, Literal

import httpx

from hippo_memory.models import (
    HealthInfo,
    MemoryEnvelope,
    RecallResult,
    ContextResult,
    OutcomeResult,
    SleepResult,
    ArchiveResult,
    SupersedeResult,
    PromoteResult,
    ForgetResult,
    DrillResult,
    AssembleResult,
    AuthCreated,
    AuthKey,
    AuthRevoked,
    AuditEvent,
    Decision,
    Incident,
    Process,
    Policy,
    Skill,
    ProjectBrief,
    CustomerNote,
    Prediction,
    PredictionBaserate,
    HippoError,
)

__all__ = ["Hippo"]


class Hippo:
    """Async client for the hippo-memory HTTP API.

    All methods are coroutines. Use as an async context manager to ensure
    the underlying httpx connection pool is closed::

        async with Hippo() as client:
            await client.remember(content="...")

    Or manage the lifetime explicitly::

        client = Hippo()
        try:
            await client.remember(content="...")
        finally:
            await client.close()
    """

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:3737",
        api_key: str | None = None,
        timeout: float = 30.0,
    ):
        headers: dict[str, str] = {"content-type": "application/json"}
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers=headers,
            timeout=timeout,
        )

    async def __aenter__(self) -> "Hippo":
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        """Close the underlying httpx AsyncClient. Safe to call multiple times."""
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        """Internal HTTP wrapper. Raises HippoError on non-2xx; returns parsed JSON on success.

        Returns None for 204 / empty-body 200 responses. Callers that expect
        a payload should treat None defensively (today every Hippo method
        passes the response straight to ``Model.model_validate`` which would
        raise on None; in practice no server route returns 204, so this code
        path is dead today. v0.2 should add either a typed empty-result
        sentinel here or a per-caller is-None check before model_validate).
        """
        response = await self._client.request(method, path, **kwargs)
        if response.status_code >= 400:
            body: dict[str, Any] | None = None
            try:
                body = response.json()
            except Exception:
                pass
            message = (body or {}).get("error") if body else response.text
            raise HippoError(response.status_code, message or response.text, body)
        if response.status_code == 204 or not response.content:
            return None
        return response.json()

    # -------------------------------------------------------------------
    # Health
    # -------------------------------------------------------------------

    async def health(self) -> HealthInfo:
        """GET /health. Returns server version + pid + boot timestamp."""
        data = await self._request("GET", "/health")
        return HealthInfo.model_validate(data)

    # -------------------------------------------------------------------
    # Memory CRUD
    # -------------------------------------------------------------------

    async def remember(
        self,
        content: str,
        *,
        kind: str | None = None,
        scope: str | None = None,
        owner: str | None = None,
        artifact_ref: str | None = None,
        tags: list[str] | None = None,
    ) -> MemoryEnvelope:
        """POST /v1/memories. Persist a new memory; returns the envelope."""
        body: dict[str, Any] = {"content": content}
        if kind is not None:
            body["kind"] = kind
        if scope is not None:
            body["scope"] = scope
        if owner is not None:
            body["owner"] = owner
        if artifact_ref is not None:
            body["artifactRef"] = artifact_ref
        if tags is not None:
            body["tags"] = tags
        data = await self._request("POST", "/v1/memories", json=body)
        return MemoryEnvelope.model_validate(data)

    async def recall(
        self,
        q: str,
        *,
        limit: int | None = None,
        mode: Literal["bm25", "hybrid", "physics"] | None = None,
        scope: str | None = None,
        include_continuity: bool = False,
        fresh_tail_count: int | None = None,
        fresh_tail_session_id: str | None = None,
        session_id: str | None = None,
    ) -> RecallResult:
        """GET /v1/memories. Search the store; returns scored results + token usage."""
        params: dict[str, Any] = {"q": q}
        if limit is not None:
            params["limit"] = limit
        if mode is not None:
            params["mode"] = mode
        if scope is not None:
            params["scope"] = scope
        if include_continuity:
            params["include_continuity"] = "1"
        if fresh_tail_count is not None:
            params["fresh_tail_count"] = fresh_tail_count
        if fresh_tail_session_id is not None:
            params["fresh_tail_session_id"] = fresh_tail_session_id
        if session_id is not None:
            params["session_id"] = session_id
        data = await self._request("GET", "/v1/memories", params=params)
        return RecallResult.model_validate(data)

    async def drill(
        self,
        memory_id: str,
        *,
        limit: int | None = None,
        budget: int | None = None,
    ) -> DrillResult:
        """GET /v1/recall/drill/:id. Drill into a memory's children (DAG)."""
        params: dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if budget is not None:
            params["budget"] = budget
        data = await self._request("GET", f"/v1/recall/drill/{memory_id}", params=params)
        return DrillResult.model_validate(data)

    async def forget(self, memory_id: str) -> ForgetResult:
        """DELETE /v1/memories/:id. Hard-delete a memory."""
        data = await self._request("DELETE", f"/v1/memories/{memory_id}")
        return ForgetResult.model_validate(data)

    async def archive(self, memory_id: str, *, reason: str | None = None) -> ArchiveResult:
        """POST /v1/memories/:id/archive. Soft-archive (for append-only raw memories)."""
        body: dict[str, Any] = {}
        if reason is not None:
            body["reason"] = reason
        data = await self._request("POST", f"/v1/memories/{memory_id}/archive", json=body)
        return ArchiveResult.model_validate(data)

    async def supersede(self, memory_id: str, *, new_id: str) -> SupersedeResult:
        """POST /v1/memories/:id/supersede. Mark a memory as superseded by another."""
        data = await self._request(
            "POST", f"/v1/memories/{memory_id}/supersede", json={"newId": new_id}
        )
        return SupersedeResult.model_validate(data)

    async def promote(self, memory_id: str) -> PromoteResult:
        """POST /v1/memories/:id/promote. Promote a local memory to the global store."""
        data = await self._request("POST", f"/v1/memories/{memory_id}/promote")
        return PromoteResult.model_validate(data)

    # -------------------------------------------------------------------
    # Outcome (Episode B)
    # -------------------------------------------------------------------

    async def outcome(
        self,
        good: bool,
        ids: list[str] | None = None,
    ) -> OutcomeResult:
        """POST /v1/outcome. Apply a positive/negative outcome to memory ids.

        If ``ids`` is None, the server uses the last-recall path
        (``last_retrieval_ids``) and returns ``{applied, ids}`` where ids is
        the tenant-filtered applied subset (v1.11.4 security guarantee).
        """
        body: dict[str, Any] = {"good": good}
        if ids is not None:
            body["ids"] = ids
        data = await self._request("POST", "/v1/outcome", json=body)
        return OutcomeResult.model_validate(data)

    # -------------------------------------------------------------------
    # Context (Episode B)
    # -------------------------------------------------------------------

    async def get_context(
        self,
        *,
        q: str | None = None,
        budget: int | None = None,
        limit: int | None = None,
        pinned_only: bool = False,
        scope: str | None = None,
        include_recent: int | None = None,
    ) -> ContextResult:
        """GET /v1/context. Assemble a budget-bounded context bundle."""
        params: dict[str, Any] = {}
        if q is not None:
            params["q"] = q
        if budget is not None:
            params["budget"] = budget
        if limit is not None:
            params["limit"] = limit
        if pinned_only:
            params["pinned_only"] = "1"
        if scope is not None:
            params["scope"] = scope
        if include_recent is not None:
            params["include_recent"] = include_recent
        data = await self._request("GET", "/v1/context", params=params)
        return ContextResult.model_validate(data)

    # -------------------------------------------------------------------
    # Sleep (Episode B) - loopback-only on the server side
    # -------------------------------------------------------------------

    async def sleep(
        self,
        *,
        dry_run: bool = False,
        no_share: bool = False,
    ) -> SleepResult:
        """POST /v1/sleep. Run the consolidation pipeline.

        Server-side enforces loopback-only (per-request guard + boot-time
        host check). Off-host callers will receive HippoError(403). The route
        operates host-wide (cross-tenant by design today); see hippo-memory
        v1.11.4 CHANGELOG for the per-tenant scoping follow-up.
        """
        body: dict[str, Any] = {}
        if dry_run:
            body["dry_run"] = True
        if no_share:
            body["no_share"] = True
        data = await self._request("POST", "/v1/sleep", json=body)
        return SleepResult.model_validate(data)

    # -------------------------------------------------------------------
    # Assemble (Phase 2 context engine)
    # -------------------------------------------------------------------

    async def assemble(self, session_id: str) -> AssembleResult:
        """GET /v1/sessions/:id/assemble. Phase 2 context-engine assembly."""
        data = await self._request("GET", f"/v1/sessions/{session_id}/assemble")
        return AssembleResult.model_validate(data)

    # -------------------------------------------------------------------
    # Auth keys
    # -------------------------------------------------------------------

    async def auth_create(
        self,
        *,
        label: str | None = None,
        role: Literal["admin", "member"] | None = None,
    ) -> AuthCreated:
        """POST /v1/auth/keys. Mint a new API key; plaintext lands ONCE in response.

        ``role`` (v1.12.3+): 'admin' | 'member'. Defaults to 'admin' server-side.
        Member keys are 403-blocked from admin-gated routes (e.g. ``/v1/sleep``).
        """
        body: dict[str, Any] = {}
        if label is not None:
            body["label"] = label
        if role is not None:
            body["role"] = role
        data = await self._request("POST", "/v1/auth/keys", json=body)
        return AuthCreated.model_validate(data)

    async def auth_list(self, *, active: bool | None = None) -> list[AuthKey]:
        """GET /v1/auth/keys. List keys visible to the caller's tenant."""
        params: dict[str, Any] = {}
        if active is not None:
            params["active"] = "true" if active else "false"
        data = await self._request("GET", "/v1/auth/keys", params=params)
        # Server returns either a list directly or {keys: [...]}; handle both.
        items = data if isinstance(data, list) else data.get("keys", [])
        return [AuthKey.model_validate(item) for item in items]

    async def auth_revoke(self, key_id: str) -> AuthRevoked:
        """DELETE /v1/auth/keys/:keyId. Revoke a key."""
        data = await self._request("DELETE", f"/v1/auth/keys/{key_id}")
        return AuthRevoked.model_validate(data)

    # -------------------------------------------------------------------
    # Audit
    # -------------------------------------------------------------------

    async def audit(
        self,
        *,
        op: str | None = None,
        since: str | None = None,
        limit: int | None = None,
    ) -> list[AuditEvent]:
        """GET /v1/audit. Read audit events scoped to the caller's tenant."""
        params: dict[str, Any] = {}
        if op is not None:
            params["op"] = op
        if since is not None:
            params["since"] = since
        if limit is not None:
            params["limit"] = limit
        data = await self._request("GET", "/v1/audit", params=params)
        # Server may return a list directly or {events: [...]}.
        items = data if isinstance(data, list) else data.get("events", [])
        return [AuditEvent.model_validate(item) for item in items]

    # -------------------------------------------------------------------
    # E2 prediction first-class object (v0.31)
    # docs/plans/2026-05-26-e2-prediction-object.md
    # -------------------------------------------------------------------

    async def predict(
        self,
        claim: str,
        *,
        class_tag: str,
        estimate: float | None = None,
        unit: str | None = None,
        target_date: str | None = None,
    ) -> Prediction:
        """POST /v1/predictions. Record an ex-ante claim. Returns the
        canonical prediction row.

        ``class_tag`` is the base-rate cohort J3 will compute against
        ("migration-effort", "rollout-risk", etc.). ``estimate`` + ``unit``
        are optional numeric fields; categorical predictions omit both.
        """
        body: dict[str, Any] = {"claim": claim, "classTag": class_tag}
        if estimate is not None:
            body["estimate"] = estimate
        if unit is not None:
            body["unit"] = unit
        if target_date is not None:
            body["targetDate"] = target_date
        data = await self._request("POST", "/v1/predictions", json=body)
        return Prediction.model_validate(data["prediction"])

    async def predict_close(
        self,
        prediction_id: int,
        *,
        state: Literal["closed", "closed-unknown"],
        actual: float | None = None,
        note: str | None = None,
    ) -> Prediction:
        """POST /v1/predictions/:id/close. Close an open prediction with
        the ex-post outcome.

        ``state="closed"`` carries a numeric ``actual``; ``"closed-unknown"``
        is for predictions whose actual outcome was not numerically
        measurable. The memory mirror is NOT mutated; the predictions row
        is canonical.
        """
        body: dict[str, Any] = {"state": state}
        if actual is not None:
            body["actual"] = actual
        if note is not None:
            body["note"] = note
        data = await self._request("POST", f"/v1/predictions/{prediction_id}/close", json=body)
        return Prediction.model_validate(data["prediction"])

    async def list_predictions(
        self,
        *,
        class_tag: str | None = None,
        status: Literal["open", "closed", "closed-unknown", "all"] | None = None,
        limit: int | None = None,
    ) -> list[Prediction]:
        """GET /v1/predictions. List predictions, optionally filtered by
        class_tag and status.

        ``status="all"`` returns everything for the class (or just open
        across classes if class_tag is omitted). Non-"open" status filters
        require a class_tag.
        """
        params: dict[str, Any] = {}
        if class_tag is not None:
            params["class"] = class_tag
        if status is not None:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        data = await self._request("GET", "/v1/predictions", params=params)
        return [Prediction.model_validate(p) for p in data["predictions"]]

    async def get_prediction(self, prediction_id: int) -> Prediction:
        """GET /v1/predictions/:id. Fetch a single prediction by id."""
        data = await self._request("GET", f"/v1/predictions/{prediction_id}")
        return Prediction.model_validate(data["prediction"])

    async def get_prediction_baserate(self, class_tag: str) -> PredictionBaserate:
        """GET /v1/predictions/stats?class=X. J3 reference-class /
        planning-fallacy detector.

        Returns base-rate stats for closed predictions in the class:
        count, mean estimate, mean actual, mean ratio, median ratio, MAE,
        plus a human-readable summary. ``n_closed = 0`` indicates no
        closed predictions yet; numeric fields will be ``None`` in that
        case and ``summary`` will be empty.

        Use when you're about to make a forward-looking claim (effort
        estimate, rollout risk, deadline) to anchor on your track record
        rather than the inside view. Lovallo-Kahneman (2003) inside-vs-
        outside view.
        """
        params: dict[str, Any] = {"class": class_tag}
        data = await self._request("GET", "/v1/predictions/stats", params=params)
        return PredictionBaserate.model_validate(data["baserate"])

    # ── decisions (E2 first-class object) ──────────────────────────────

    async def decide(
        self,
        text: str,
        *,
        context: str | None = None,
    ) -> Decision:
        """POST /v1/decisions. Record a decision as a first-class object.

        Returns the canonical decision row. The decisions table is the source
        of truth, so the decision stays ``active`` regardless of memory decay
        (unlike the old decision-tagged memory, which decayed in 90 days).
        """
        body: dict[str, Any] = {"text": text}
        if context is not None:
            body["context"] = context
        data = await self._request("POST", "/v1/decisions", json=body)
        return Decision.model_validate(data["decision"])

    async def supersede_decision(
        self,
        decision_id: int,
        text: str,
        *,
        context: str | None = None,
    ) -> Decision:
        """POST /v1/decisions/:id/supersede. Create a successor decision and
        mark ``decision_id`` superseded, atomically. Returns the NEW decision.
        """
        body: dict[str, Any] = {"text": text}
        if context is not None:
            body["context"] = context
        data = await self._request("POST", f"/v1/decisions/{decision_id}/supersede", json=body)
        return Decision.model_validate(data["decision"])

    async def close_decision(self, decision_id: int) -> Decision:
        """POST /v1/decisions/:id/close. Retire an active decision (no
        successor). Returns the closed decision row.
        """
        data = await self._request("POST", f"/v1/decisions/{decision_id}/close", json={})
        return Decision.model_validate(data["decision"])

    async def list_decisions(
        self,
        *,
        status: Literal["active", "superseded", "closed", "all"] | None = None,
        limit: int | None = None,
    ) -> list[Decision]:
        """GET /v1/decisions. List decisions, optionally filtered by status."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        data = await self._request("GET", "/v1/decisions", params=params)
        return [Decision.model_validate(d) for d in data["decisions"]]

    async def get_decision(self, decision_id: int) -> Decision:
        """GET /v1/decisions/:id. Fetch a single decision by id."""
        data = await self._request("GET", f"/v1/decisions/{decision_id}")
        return Decision.model_validate(data["decision"])

    # ── incidents (E2 first-class object) ──────────────────────────────

    async def open_incident(
        self,
        text: str,
        *,
        context: str | None = None,
        linked_memory_ids: list[str] | None = None,
    ) -> Incident:
        """POST /v1/incidents. Record an incident as a first-class object.

        Returns the canonical incident row (status ``open``). The incidents
        table is the source of truth, so the incident stays ``open`` regardless
        of memory decay. ``linked_memory_ids`` are evidence receipts; each must
        exist in the same tenant or the call is rejected.
        """
        body: dict[str, Any] = {"text": text}
        if context is not None:
            body["context"] = context
        if linked_memory_ids is not None:
            body["linkedMemoryIds"] = linked_memory_ids
        data = await self._request("POST", "/v1/incidents", json=body)
        return Incident.model_validate(data["incident"])

    async def resolve_incident(self, incident_id: int, resolution_text: str) -> Incident:
        """POST /v1/incidents/:id/resolve. Resolve an open incident
        (open -> resolved), recording ``resolution_text``. Returns the resolved
        incident row.
        """
        body: dict[str, Any] = {"resolutionText": resolution_text}
        data = await self._request("POST", f"/v1/incidents/{incident_id}/resolve", json=body)
        return Incident.model_validate(data["incident"])

    async def close_incident(self, incident_id: int) -> Incident:
        """POST /v1/incidents/:id/close. Retire an incident (open|resolved ->
        closed). Returns the closed incident row.
        """
        data = await self._request("POST", f"/v1/incidents/{incident_id}/close", json={})
        return Incident.model_validate(data["incident"])

    async def list_incidents(
        self,
        *,
        status: Literal["open", "resolved", "closed", "all"] | None = None,
        limit: int | None = None,
    ) -> list[Incident]:
        """GET /v1/incidents. List incidents, optionally filtered by status."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        data = await self._request("GET", "/v1/incidents", params=params)
        return [Incident.model_validate(i) for i in data["incidents"]]

    async def get_incident(self, incident_id: int) -> Incident:
        """GET /v1/incidents/:id. Fetch a single incident by id."""
        data = await self._request("GET", f"/v1/incidents/{incident_id}")
        return Incident.model_validate(data["incident"])

    async def new_process(
        self,
        process_name: str,
        *,
        steps: list[str] | None = None,
        description: str | None = None,
    ) -> Process:
        """POST /v1/processes. Record a process map as a first-class object.

        Returns the canonical process row (status ``active``, ``version`` 1).
        The processes table is the source of truth, so the process stays
        ``active`` regardless of memory decay. ``steps`` is the ordered body.
        """
        body: dict[str, Any] = {"processName": process_name}
        if steps is not None:
            body["steps"] = steps
        if description is not None:
            body["description"] = description
        data = await self._request("POST", "/v1/processes", json=body)
        return Process.model_validate(data["process"])

    async def supersede_process(
        self,
        process_id: int,
        steps: list[str],
        *,
        change_summary: str | None = None,
        description: str | None = None,
    ) -> Process:
        """POST /v1/processes/:id/supersede. Record a new version that
        supersedes an active process (active -> superseded). The new version
        reuses the predecessor's name and carries an incremented ``version``;
        ``change_summary`` is the delta note. Returns the new active version.
        """
        body: dict[str, Any] = {"steps": steps}
        if change_summary is not None:
            body["changeSummary"] = change_summary
        if description is not None:
            body["description"] = description
        data = await self._request("POST", f"/v1/processes/{process_id}/supersede", json=body)
        return Process.model_validate(data["process"])

    async def close_process(self, process_id: int) -> Process:
        """POST /v1/processes/:id/close. Retire an active process
        (active -> closed). Returns the closed process row.
        """
        data = await self._request("POST", f"/v1/processes/{process_id}/close", json={})
        return Process.model_validate(data["process"])

    async def list_processes(
        self,
        *,
        status: Literal["active", "superseded", "closed", "all"] | None = None,
        limit: int | None = None,
    ) -> list[Process]:
        """GET /v1/processes. List processes, optionally filtered by status."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        data = await self._request("GET", "/v1/processes", params=params)
        return [Process.model_validate(p) for p in data["processes"]]

    async def get_process(self, process_id: int) -> Process:
        """GET /v1/processes/:id. Fetch a single process by id."""
        data = await self._request("GET", f"/v1/processes/{process_id}")
        return Process.model_validate(data["process"])

    async def new_policy(
        self,
        policy_name: str,
        policy_text: str,
        *,
        valid_from: str | None = None,
        valid_to: str | None = None,
    ) -> Policy:
        """POST /v1/policies. Record a policy (bi-temporal first-class object).

        ``valid_from`` defaults server-side to now when omitted; ``valid_to`` is
        open-ended when omitted. Both are normalized to canonical ISO-8601; an
        unparseable date or valid_to <= valid_from is rejected with 400.
        """
        body: dict[str, Any] = {"policyName": policy_name, "policyText": policy_text}
        if valid_from is not None:
            body["validFrom"] = valid_from
        if valid_to is not None:
            body["validTo"] = valid_to
        data = await self._request("POST", "/v1/policies", json=body)
        return Policy.model_validate(data["policy"])

    async def supersede_policy(
        self,
        policy_id: int,
        policy_text: str,
        *,
        valid_from: str | None = None,
        valid_to: str | None = None,
        change_summary: str | None = None,
    ) -> Policy:
        """POST /v1/policies/:id/supersede. Record a new version that supersedes
        an active policy (active -> superseded). Reuses the predecessor's name;
        ``change_summary`` is the delta note. Returns the new active version.
        """
        body: dict[str, Any] = {"policyText": policy_text}
        if valid_from is not None:
            body["validFrom"] = valid_from
        if valid_to is not None:
            body["validTo"] = valid_to
        if change_summary is not None:
            body["changeSummary"] = change_summary
        data = await self._request("POST", f"/v1/policies/{policy_id}/supersede", json=body)
        return Policy.model_validate(data["policy"])

    async def close_policy(self, policy_id: int) -> Policy:
        """POST /v1/policies/:id/close. Retire an active policy (active -> closed)."""
        data = await self._request("POST", f"/v1/policies/{policy_id}/close", json={})
        return Policy.model_validate(data["policy"])

    async def list_policies(
        self,
        *,
        status: Literal["active", "superseded", "closed", "all"] | None = None,
        limit: int | None = None,
    ) -> list[Policy]:
        """GET /v1/policies. List policies, optionally filtered by status."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        data = await self._request("GET", "/v1/policies", params=params)
        return [Policy.model_validate(p) for p in data["policies"]]

    async def get_policy(self, policy_id: int) -> Policy:
        """GET /v1/policies/:id. Fetch a single policy by id."""
        data = await self._request("GET", f"/v1/policies/{policy_id}")
        return Policy.model_validate(data["policy"])

    async def policies_asof(
        self,
        as_of_date: str,
        *,
        name: str | None = None,
    ) -> list[Policy]:
        """GET /v1/policies/asof. The bi-temporal as-of query: active policies in
        force at ``as_of_date`` (a valid-time), optionally filtered by name.
        """
        params: dict[str, Any] = {"date": as_of_date}
        if name is not None:
            params["name"] = name
        data = await self._request("GET", "/v1/policies/asof", params=params)
        return [Policy.model_validate(p) for p in data["policies"]]

    async def new_skill(
        self,
        skill_name: str,
        instructions: str,
        *,
        trigger: str | None = None,
    ) -> Skill:
        """POST /v1/skills. Record a reusable, agent-followable skill (instructions
        + optional trigger). The skills table is the source of truth.
        """
        body: dict[str, Any] = {"skillName": skill_name, "instructions": instructions}
        if trigger is not None:
            body["trigger"] = trigger
        data = await self._request("POST", "/v1/skills", json=body)
        return Skill.model_validate(data["skill"])

    async def supersede_skill(
        self,
        skill_id: int,
        instructions: str,
        *,
        trigger: str | None = None,
        change_summary: str | None = None,
    ) -> Skill:
        """POST /v1/skills/:id/supersede. Record a new version that supersedes an
        active skill (active -> superseded). Reuses the predecessor's name.
        """
        body: dict[str, Any] = {"instructions": instructions}
        if trigger is not None:
            body["trigger"] = trigger
        if change_summary is not None:
            body["changeSummary"] = change_summary
        data = await self._request("POST", f"/v1/skills/{skill_id}/supersede", json=body)
        return Skill.model_validate(data["skill"])

    async def close_skill(self, skill_id: int) -> Skill:
        """POST /v1/skills/:id/close. Retire an active skill (active -> closed)."""
        data = await self._request("POST", f"/v1/skills/{skill_id}/close", json={})
        return Skill.model_validate(data["skill"])

    async def list_skills(
        self,
        *,
        status: Literal["active", "superseded", "closed", "all"] | None = None,
        limit: int | None = None,
    ) -> list[Skill]:
        """GET /v1/skills. List skills, optionally filtered by status."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        data = await self._request("GET", "/v1/skills", params=params)
        return [Skill.model_validate(s) for s in data["skills"]]

    async def get_skill(self, skill_id: int) -> Skill:
        """GET /v1/skills/:id. Fetch a single skill by id."""
        data = await self._request("GET", f"/v1/skills/{skill_id}")
        return Skill.model_validate(data["skill"])

    async def export_skills(self) -> str:
        """GET /v1/skills/export. Render the tenant's ACTIVE skills as one
        AGENTS.md / CLAUDE.md-style markdown block. Returns the markdown string
        (empty string when there are no active skills).
        """
        data = await self._request("GET", "/v1/skills/export")
        return data["markdown"]

    async def new_project_brief(self, repo: str, summary: str) -> ProjectBrief:
        """POST /v1/project-briefs. Record a repo-scoped project brief. The
        project_briefs table is the source of truth.
        """
        body: dict[str, Any] = {"repo": repo, "summary": summary}
        data = await self._request("POST", "/v1/project-briefs", json=body)
        return ProjectBrief.model_validate(data["brief"])

    async def supersede_project_brief(
        self,
        brief_id: int,
        summary: str,
        *,
        change_summary: str | None = None,
    ) -> ProjectBrief:
        """POST /v1/project-briefs/:id/supersede. Record a new version that
        supersedes an active brief (active -> superseded). Reuses the
        predecessor's repo.
        """
        body: dict[str, Any] = {"summary": summary}
        if change_summary is not None:
            body["changeSummary"] = change_summary
        data = await self._request("POST", f"/v1/project-briefs/{brief_id}/supersede", json=body)
        return ProjectBrief.model_validate(data["brief"])

    async def close_project_brief(self, brief_id: int) -> ProjectBrief:
        """POST /v1/project-briefs/:id/close. Retire an active brief (active -> closed)."""
        data = await self._request("POST", f"/v1/project-briefs/{brief_id}/close", json={})
        return ProjectBrief.model_validate(data["brief"])

    async def list_project_briefs(
        self,
        *,
        status: Literal["active", "superseded", "closed", "all"] | None = None,
        repo: str | None = None,
        limit: int | None = None,
    ) -> list[ProjectBrief]:
        """GET /v1/project-briefs. List briefs, optionally filtered by status / repo."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if repo is not None:
            params["repo"] = repo
        if limit is not None:
            params["limit"] = limit
        data = await self._request("GET", "/v1/project-briefs", params=params)
        return [ProjectBrief.model_validate(b) for b in data["briefs"]]

    async def get_project_brief(self, brief_id: int) -> ProjectBrief:
        """GET /v1/project-briefs/:id. Fetch a single brief by id."""
        data = await self._request("GET", f"/v1/project-briefs/{brief_id}")
        return ProjectBrief.model_validate(data["brief"])

    async def refresh_project_brief(self, repo: str) -> ProjectBrief:
        """POST /v1/project-briefs/refresh. Auto-assemble the repo's brief from its
        receipts (memory rows tagged ``path:<repo>``) and record it as a new version
        (supersedes the repo's current active brief, or creates v1).
        """
        data = await self._request("POST", "/v1/project-briefs/refresh", json={"repo": repo})
        return ProjectBrief.model_validate(data["brief"])

    async def new_customer_note(self, customer: str, note: str) -> CustomerNote:
        """POST /v1/customer-notes. Record a note scoped to an account/customer entity.
        The customer_notes table is the source of truth.
        """
        body: dict[str, Any] = {"customer": customer, "note": note}
        data = await self._request("POST", "/v1/customer-notes", json=body)
        return CustomerNote.model_validate(data["note"])

    async def supersede_customer_note(
        self,
        note_id: int,
        note: str,
        *,
        change_summary: str | None = None,
    ) -> CustomerNote:
        """POST /v1/customer-notes/:id/supersede. Record a new version that supersedes
        an active note (active -> superseded). Reuses the predecessor's customer.
        """
        body: dict[str, Any] = {"note": note}
        if change_summary is not None:
            body["changeSummary"] = change_summary
        data = await self._request("POST", f"/v1/customer-notes/{note_id}/supersede", json=body)
        return CustomerNote.model_validate(data["note"])

    async def close_customer_note(self, note_id: int) -> CustomerNote:
        """POST /v1/customer-notes/:id/close. Retire an active note (active -> closed)."""
        data = await self._request("POST", f"/v1/customer-notes/{note_id}/close", json={})
        return CustomerNote.model_validate(data["note"])

    async def list_customer_notes(
        self,
        *,
        status: Literal["active", "superseded", "closed", "all"] | None = None,
        customer: str | None = None,
        limit: int | None = None,
    ) -> list[CustomerNote]:
        """GET /v1/customer-notes. List notes, optionally filtered by status / customer."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if customer is not None:
            params["customer"] = customer
        if limit is not None:
            params["limit"] = limit
        data = await self._request("GET", "/v1/customer-notes", params=params)
        return [CustomerNote.model_validate(n) for n in data["notes"]]

    async def get_customer_note(self, note_id: int) -> CustomerNote:
        """GET /v1/customer-notes/:id. Fetch a single note by id."""
        data = await self._request("GET", f"/v1/customer-notes/{note_id}")
        return CustomerNote.model_validate(data["note"])
