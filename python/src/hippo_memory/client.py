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
        """Internal HTTP wrapper. Raises HippoError on non-2xx; returns parsed JSON on success."""
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

    async def auth_create(self, *, label: str | None = None) -> AuthCreated:
        """POST /v1/auth/keys. Mint a new API key; plaintext lands ONCE in response."""
        body: dict[str, Any] = {}
        if label is not None:
            body["label"] = label
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
