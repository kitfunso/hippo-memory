"""Sync httpx client for hippo-memory HTTP API (v0.2.0).

The main public class is :class:`HippoSync`. A line-for-line mirror of
:class:`hippo_memory.client.Hippo` using ``httpx.Client`` instead of
``httpx.AsyncClient``. Each method is the sync equivalent; the wire shape,
return models, and error semantics are identical.

Use when:
- Your code already runs synchronously (CLI scripts, notebooks).
- You can't ``await`` cleanly (e.g. inside a ``threading.Thread`` callback).
- You don't want to manage an event loop.

Example::

    from hippo_memory import HippoSync

    with HippoSync(base_url="http://127.0.0.1:3737") as client:
        mem = client.remember(content="bug fix lesson")
        results = client.recall(q="bug fix")
        ctx = client.get_context(budget=1500)
        client.outcome(good=True)

The async :class:`Hippo` class remains the recommended default — only
adopt :class:`HippoSync` when you have a specific reason to avoid
``asyncio``.
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
    Prediction,
    PredictionBaserate,
    HippoError,
)

__all__ = ["HippoSync"]


class HippoSync:
    """Sync client for the hippo-memory HTTP API.

    All methods are synchronous. Use as a context manager to ensure the
    underlying httpx connection pool is closed::

        with HippoSync() as client:
            client.remember(content="...")

    Or manage the lifetime explicitly::

        client = HippoSync()
        try:
            client.remember(content="...")
        finally:
            client.close()

    Wire-compatible with the async :class:`Hippo` — same routes, same
    request/response models, same errors. The only difference is the
    `async`/`await` keywords and the underlying httpx client class.
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
        self._client = httpx.Client(
            base_url=base_url,
            headers=headers,
            timeout=timeout,
        )

    def __enter__(self) -> "HippoSync":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def close(self) -> None:
        """Close the underlying httpx Client. Safe to call multiple times."""
        self._client.close()

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        """Internal HTTP wrapper. Raises HippoError on non-2xx; returns parsed JSON on success.

        Returns None for 204 / empty-body 200 responses. Callers that expect
        a payload pass the result straight to ``Model.model_validate`` which
        will raise on None — no server route currently returns 204, but if
        one ever does, switch to ``_expect_body`` (v0.3 candidate).
        """
        response = self._client.request(method, path, **kwargs)
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

    def health(self) -> HealthInfo:
        """GET /health. Returns server version + pid + boot timestamp."""
        data = self._request("GET", "/health")
        return HealthInfo.model_validate(data)

    # -------------------------------------------------------------------
    # Memory CRUD
    # -------------------------------------------------------------------

    def remember(
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
        data = self._request("POST", "/v1/memories", json=body)
        return MemoryEnvelope.model_validate(data)

    def recall(
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
        """GET /v1/memories. Search the store; returns scored results + token usage.

        Note: as of hippo-memory v1.12.4, this does NOT populate
        ``last_retrieval_ids`` (the SDK + HTTP recall path mirrors api.recall's
        documented divergence from CLI). Use :meth:`get_context` to prime the
        last-recall outcome workflow.
        """
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
        data = self._request("GET", "/v1/memories", params=params)
        return RecallResult.model_validate(data)

    def drill(
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
        data = self._request("GET", f"/v1/recall/drill/{memory_id}", params=params)
        return DrillResult.model_validate(data)

    def forget(self, memory_id: str) -> ForgetResult:
        """DELETE /v1/memories/:id. Hard-delete a memory."""
        data = self._request("DELETE", f"/v1/memories/{memory_id}")
        return ForgetResult.model_validate(data)

    def archive(self, memory_id: str, *, reason: str | None = None) -> ArchiveResult:
        """POST /v1/memories/:id/archive. Soft-archive (for append-only raw memories)."""
        body: dict[str, Any] = {}
        if reason is not None:
            body["reason"] = reason
        data = self._request("POST", f"/v1/memories/{memory_id}/archive", json=body)
        return ArchiveResult.model_validate(data)

    def supersede(self, memory_id: str, *, new_id: str) -> SupersedeResult:
        """POST /v1/memories/:id/supersede. Mark a memory as superseded by another."""
        data = self._request(
            "POST", f"/v1/memories/{memory_id}/supersede", json={"newId": new_id}
        )
        return SupersedeResult.model_validate(data)

    def promote(self, memory_id: str) -> PromoteResult:
        """POST /v1/memories/:id/promote. Promote a local memory to the global store."""
        data = self._request("POST", f"/v1/memories/{memory_id}/promote")
        return PromoteResult.model_validate(data)

    # -------------------------------------------------------------------
    # Outcome (Episode B)
    # -------------------------------------------------------------------

    def outcome(
        self,
        good: bool,
        ids: list[str] | None = None,
    ) -> OutcomeResult:
        """POST /v1/outcome. Apply a positive/negative outcome to memory ids."""
        body: dict[str, Any] = {"good": good}
        if ids is not None:
            body["ids"] = ids
        data = self._request("POST", "/v1/outcome", json=body)
        return OutcomeResult.model_validate(data)

    # -------------------------------------------------------------------
    # Context (Episode B)
    # -------------------------------------------------------------------

    def get_context(
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
        data = self._request("GET", "/v1/context", params=params)
        return ContextResult.model_validate(data)

    # -------------------------------------------------------------------
    # Sleep (Episode B) - loopback-only on the server side, admin-gated since v1.12.0
    # -------------------------------------------------------------------

    def sleep(
        self,
        *,
        dry_run: bool = False,
        no_share: bool = False,
    ) -> SleepResult:
        """POST /v1/sleep. Run the consolidation pipeline.

        Server-side enforces loopback-only + admin role (v1.12.0 sub-1).
        Off-host callers receive HippoError(403); member-Bearer callers
        receive HippoError(403).
        """
        body: dict[str, Any] = {}
        if dry_run:
            body["dry_run"] = True
        if no_share:
            body["no_share"] = True
        data = self._request("POST", "/v1/sleep", json=body)
        return SleepResult.model_validate(data)

    # -------------------------------------------------------------------
    # Assemble (Phase 2 context engine)
    # -------------------------------------------------------------------

    def assemble(self, session_id: str) -> AssembleResult:
        """GET /v1/sessions/:id/assemble. Phase 2 context-engine assembly."""
        data = self._request("GET", f"/v1/sessions/{session_id}/assemble")
        return AssembleResult.model_validate(data)

    # -------------------------------------------------------------------
    # Auth keys
    # -------------------------------------------------------------------

    def auth_create(
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
        data = self._request("POST", "/v1/auth/keys", json=body)
        return AuthCreated.model_validate(data)

    def auth_list(self, *, active: bool | None = None) -> list[AuthKey]:
        """GET /v1/auth/keys. List keys visible to the caller's tenant."""
        params: dict[str, Any] = {}
        if active is not None:
            params["active"] = "true" if active else "false"
        data = self._request("GET", "/v1/auth/keys", params=params)
        items = data if isinstance(data, list) else data.get("keys", [])
        return [AuthKey.model_validate(item) for item in items]

    def auth_revoke(self, key_id: str) -> AuthRevoked:
        """DELETE /v1/auth/keys/:keyId. Revoke a key."""
        data = self._request("DELETE", f"/v1/auth/keys/{key_id}")
        return AuthRevoked.model_validate(data)

    # -------------------------------------------------------------------
    # Audit
    # -------------------------------------------------------------------

    def audit(
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
        data = self._request("GET", "/v1/audit", params=params)
        items = data if isinstance(data, list) else data.get("events", [])
        return [AuditEvent.model_validate(item) for item in items]

    # -------------------------------------------------------------------
    # E2 prediction first-class object (v0.31)
    # docs/plans/2026-05-26-e2-prediction-object.md
    # -------------------------------------------------------------------

    def predict(
        self,
        claim: str,
        *,
        class_tag: str,
        estimate: float | None = None,
        unit: str | None = None,
        target_date: str | None = None,
    ) -> Prediction:
        """POST /v1/predictions. Sync mirror of Hippo.predict."""
        body: dict[str, Any] = {"claim": claim, "classTag": class_tag}
        if estimate is not None:
            body["estimate"] = estimate
        if unit is not None:
            body["unit"] = unit
        if target_date is not None:
            body["targetDate"] = target_date
        data = self._request("POST", "/v1/predictions", json=body)
        return Prediction.model_validate(data["prediction"])

    def predict_close(
        self,
        prediction_id: int,
        *,
        state: Literal["closed", "closed-unknown"],
        actual: float | None = None,
        note: str | None = None,
    ) -> Prediction:
        """POST /v1/predictions/:id/close. Sync mirror of Hippo.predict_close."""
        body: dict[str, Any] = {"state": state}
        if actual is not None:
            body["actual"] = actual
        if note is not None:
            body["note"] = note
        data = self._request("POST", f"/v1/predictions/{prediction_id}/close", json=body)
        return Prediction.model_validate(data["prediction"])

    def list_predictions(
        self,
        *,
        class_tag: str | None = None,
        status: Literal["open", "closed", "closed-unknown", "all"] | None = None,
        limit: int | None = None,
    ) -> list[Prediction]:
        """GET /v1/predictions. Sync mirror of Hippo.list_predictions."""
        params: dict[str, Any] = {}
        if class_tag is not None:
            params["class"] = class_tag
        if status is not None:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        data = self._request("GET", "/v1/predictions", params=params)
        return [Prediction.model_validate(p) for p in data["predictions"]]

    def get_prediction(self, prediction_id: int) -> Prediction:
        """GET /v1/predictions/:id. Sync mirror of Hippo.get_prediction."""
        data = self._request("GET", f"/v1/predictions/{prediction_id}")
        return Prediction.model_validate(data["prediction"])

    def get_prediction_baserate(self, class_tag: str) -> PredictionBaserate:
        """GET /v1/predictions/stats. Sync mirror of Hippo.get_prediction_baserate.
        J3 reference-class / planning-fallacy detector."""
        params: dict[str, Any] = {"class": class_tag}
        data = self._request("GET", "/v1/predictions/stats", params=params)
        return PredictionBaserate.model_validate(data["baserate"])

    # ── decisions (E2 first-class object) ──────────────────────────────

    def decide(self, text: str, *, context: str | None = None) -> Decision:
        """POST /v1/decisions. Sync mirror of Hippo.decide."""
        body: dict[str, Any] = {"text": text}
        if context is not None:
            body["context"] = context
        data = self._request("POST", "/v1/decisions", json=body)
        return Decision.model_validate(data["decision"])

    def supersede_decision(
        self,
        decision_id: int,
        text: str,
        *,
        context: str | None = None,
    ) -> Decision:
        """POST /v1/decisions/:id/supersede. Sync mirror of
        Hippo.supersede_decision. Returns the NEW decision."""
        body: dict[str, Any] = {"text": text}
        if context is not None:
            body["context"] = context
        data = self._request("POST", f"/v1/decisions/{decision_id}/supersede", json=body)
        return Decision.model_validate(data["decision"])

    def close_decision(self, decision_id: int) -> Decision:
        """POST /v1/decisions/:id/close. Sync mirror of Hippo.close_decision."""
        data = self._request("POST", f"/v1/decisions/{decision_id}/close", json={})
        return Decision.model_validate(data["decision"])

    def list_decisions(
        self,
        *,
        status: Literal["active", "superseded", "closed", "all"] | None = None,
        limit: int | None = None,
    ) -> list[Decision]:
        """GET /v1/decisions. Sync mirror of Hippo.list_decisions."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        data = self._request("GET", "/v1/decisions", params=params)
        return [Decision.model_validate(d) for d in data["decisions"]]

    def get_decision(self, decision_id: int) -> Decision:
        """GET /v1/decisions/:id. Sync mirror of Hippo.get_decision."""
        data = self._request("GET", f"/v1/decisions/{decision_id}")
        return Decision.model_validate(data["decision"])

    # ── incidents (E2 first-class object) ──────────────────────────────

    def open_incident(
        self,
        text: str,
        *,
        context: str | None = None,
        linked_memory_ids: list[str] | None = None,
    ) -> Incident:
        """POST /v1/incidents. Sync mirror of Hippo.open_incident."""
        body: dict[str, Any] = {"text": text}
        if context is not None:
            body["context"] = context
        if linked_memory_ids is not None:
            body["linkedMemoryIds"] = linked_memory_ids
        data = self._request("POST", "/v1/incidents", json=body)
        return Incident.model_validate(data["incident"])

    def resolve_incident(self, incident_id: int, resolution_text: str) -> Incident:
        """POST /v1/incidents/:id/resolve. Sync mirror of Hippo.resolve_incident."""
        body: dict[str, Any] = {"resolutionText": resolution_text}
        data = self._request("POST", f"/v1/incidents/{incident_id}/resolve", json=body)
        return Incident.model_validate(data["incident"])

    def close_incident(self, incident_id: int) -> Incident:
        """POST /v1/incidents/:id/close. Sync mirror of Hippo.close_incident."""
        data = self._request("POST", f"/v1/incidents/{incident_id}/close", json={})
        return Incident.model_validate(data["incident"])

    def list_incidents(
        self,
        *,
        status: Literal["open", "resolved", "closed", "all"] | None = None,
        limit: int | None = None,
    ) -> list[Incident]:
        """GET /v1/incidents. Sync mirror of Hippo.list_incidents."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        data = self._request("GET", "/v1/incidents", params=params)
        return [Incident.model_validate(i) for i in data["incidents"]]

    def get_incident(self, incident_id: int) -> Incident:
        """GET /v1/incidents/:id. Sync mirror of Hippo.get_incident."""
        data = self._request("GET", f"/v1/incidents/{incident_id}")
        return Incident.model_validate(data["incident"])

    def new_process(
        self,
        process_name: str,
        *,
        steps: list[str] | None = None,
        description: str | None = None,
    ) -> Process:
        """POST /v1/processes. Sync mirror of Hippo.new_process."""
        body: dict[str, Any] = {"processName": process_name}
        if steps is not None:
            body["steps"] = steps
        if description is not None:
            body["description"] = description
        data = self._request("POST", "/v1/processes", json=body)
        return Process.model_validate(data["process"])

    def supersede_process(
        self,
        process_id: int,
        steps: list[str],
        *,
        change_summary: str | None = None,
        description: str | None = None,
    ) -> Process:
        """POST /v1/processes/:id/supersede. Sync mirror of Hippo.supersede_process."""
        body: dict[str, Any] = {"steps": steps}
        if change_summary is not None:
            body["changeSummary"] = change_summary
        if description is not None:
            body["description"] = description
        data = self._request("POST", f"/v1/processes/{process_id}/supersede", json=body)
        return Process.model_validate(data["process"])

    def close_process(self, process_id: int) -> Process:
        """POST /v1/processes/:id/close. Sync mirror of Hippo.close_process."""
        data = self._request("POST", f"/v1/processes/{process_id}/close", json={})
        return Process.model_validate(data["process"])

    def list_processes(
        self,
        *,
        status: Literal["active", "superseded", "closed", "all"] | None = None,
        limit: int | None = None,
    ) -> list[Process]:
        """GET /v1/processes. Sync mirror of Hippo.list_processes."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        data = self._request("GET", "/v1/processes", params=params)
        return [Process.model_validate(p) for p in data["processes"]]

    def get_process(self, process_id: int) -> Process:
        """GET /v1/processes/:id. Sync mirror of Hippo.get_process."""
        data = self._request("GET", f"/v1/processes/{process_id}")
        return Process.model_validate(data["process"])

    def new_policy(
        self,
        policy_name: str,
        policy_text: str,
        *,
        valid_from: str | None = None,
        valid_to: str | None = None,
    ) -> Policy:
        """POST /v1/policies. Sync mirror of Hippo.new_policy."""
        body: dict[str, Any] = {"policyName": policy_name, "policyText": policy_text}
        if valid_from is not None:
            body["validFrom"] = valid_from
        if valid_to is not None:
            body["validTo"] = valid_to
        data = self._request("POST", "/v1/policies", json=body)
        return Policy.model_validate(data["policy"])

    def supersede_policy(
        self,
        policy_id: int,
        policy_text: str,
        *,
        valid_from: str | None = None,
        valid_to: str | None = None,
        change_summary: str | None = None,
    ) -> Policy:
        """POST /v1/policies/:id/supersede. Sync mirror of Hippo.supersede_policy."""
        body: dict[str, Any] = {"policyText": policy_text}
        if valid_from is not None:
            body["validFrom"] = valid_from
        if valid_to is not None:
            body["validTo"] = valid_to
        if change_summary is not None:
            body["changeSummary"] = change_summary
        data = self._request("POST", f"/v1/policies/{policy_id}/supersede", json=body)
        return Policy.model_validate(data["policy"])

    def close_policy(self, policy_id: int) -> Policy:
        """POST /v1/policies/:id/close. Sync mirror of Hippo.close_policy."""
        data = self._request("POST", f"/v1/policies/{policy_id}/close", json={})
        return Policy.model_validate(data["policy"])

    def list_policies(
        self,
        *,
        status: Literal["active", "superseded", "closed", "all"] | None = None,
        limit: int | None = None,
    ) -> list[Policy]:
        """GET /v1/policies. Sync mirror of Hippo.list_policies."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        data = self._request("GET", "/v1/policies", params=params)
        return [Policy.model_validate(p) for p in data["policies"]]

    def get_policy(self, policy_id: int) -> Policy:
        """GET /v1/policies/:id. Sync mirror of Hippo.get_policy."""
        data = self._request("GET", f"/v1/policies/{policy_id}")
        return Policy.model_validate(data["policy"])

    def policies_asof(
        self,
        as_of_date: str,
        *,
        name: str | None = None,
    ) -> list[Policy]:
        """GET /v1/policies/asof. Sync mirror of Hippo.policies_asof."""
        params: dict[str, Any] = {"date": as_of_date}
        if name is not None:
            params["name"] = name
        data = self._request("GET", "/v1/policies/asof", params=params)
        return [Policy.model_validate(p) for p in data["policies"]]

    def new_skill(
        self,
        skill_name: str,
        instructions: str,
        *,
        trigger: str | None = None,
    ) -> Skill:
        """POST /v1/skills. Sync mirror of Hippo.new_skill."""
        body: dict[str, Any] = {"skillName": skill_name, "instructions": instructions}
        if trigger is not None:
            body["trigger"] = trigger
        data = self._request("POST", "/v1/skills", json=body)
        return Skill.model_validate(data["skill"])

    def supersede_skill(
        self,
        skill_id: int,
        instructions: str,
        *,
        trigger: str | None = None,
        change_summary: str | None = None,
    ) -> Skill:
        """POST /v1/skills/:id/supersede. Sync mirror of Hippo.supersede_skill."""
        body: dict[str, Any] = {"instructions": instructions}
        if trigger is not None:
            body["trigger"] = trigger
        if change_summary is not None:
            body["changeSummary"] = change_summary
        data = self._request("POST", f"/v1/skills/{skill_id}/supersede", json=body)
        return Skill.model_validate(data["skill"])

    def close_skill(self, skill_id: int) -> Skill:
        """POST /v1/skills/:id/close. Sync mirror of Hippo.close_skill."""
        data = self._request("POST", f"/v1/skills/{skill_id}/close", json={})
        return Skill.model_validate(data["skill"])

    def list_skills(
        self,
        *,
        status: Literal["active", "superseded", "closed", "all"] | None = None,
        limit: int | None = None,
    ) -> list[Skill]:
        """GET /v1/skills. Sync mirror of Hippo.list_skills."""
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        data = self._request("GET", "/v1/skills", params=params)
        return [Skill.model_validate(s) for s in data["skills"]]

    def get_skill(self, skill_id: int) -> Skill:
        """GET /v1/skills/:id. Sync mirror of Hippo.get_skill."""
        data = self._request("GET", f"/v1/skills/{skill_id}")
        return Skill.model_validate(data["skill"])

    def export_skills(self) -> str:
        """GET /v1/skills/export. Sync mirror of Hippo.export_skills."""
        data = self._request("GET", "/v1/skills/export")
        return data["markdown"]
