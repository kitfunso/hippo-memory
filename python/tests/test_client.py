from __future__ import annotations

import pytest

from hippo_memory import Hippo, HippoError


pytestmark = pytest.mark.asyncio


async def test_health_reports_version(hippo_server: str, hippo_member_key: str):
    async with Hippo(base_url=hippo_server, api_key=hippo_member_key) as client:
        info = await client.health()
        assert info.ok is True
        assert tuple(int(p) for p in info.version.split(".")[:3]) >= (1, 11, 4)
        assert info.pid > 0


async def test_remember_recall_roundtrip(hippo_server: str, hippo_member_key: str):
    async with Hippo(base_url=hippo_server, api_key=hippo_member_key) as client:
        mem = await client.remember(content="integration alpha token sentinel")
        assert mem.id.startswith("mem_")
        result = await client.recall(q="alpha token sentinel", limit=5)
        assert result.total >= 1
        assert any(e.id == mem.id for e in result.results)


async def test_get_context_returns_seeded_memory(hippo_server: str, hippo_member_key: str):
    async with Hippo(base_url=hippo_server, api_key=hippo_member_key) as client:
        await client.remember(content="context-test seed memory")
        ctx = await client.get_context(budget=1500)
        contents = [e.entry.content for e in ctx.entries]
        assert "context-test seed memory" in contents


async def test_outcome_with_ids(hippo_server: str, hippo_member_key: str):
    async with Hippo(base_url=hippo_server, api_key=hippo_member_key) as client:
        mem = await client.remember(content="outcome-with-ids target")
        result = await client.outcome(good=True, ids=[mem.id])
        assert result.applied == 1


async def test_outcome_last_recall_path(hippo_server: str, hippo_member_key: str):
    async with Hippo(base_url=hippo_server, api_key=hippo_member_key) as client:
        mem = await client.remember(content="last-recall outcome target")
        await client.get_context(budget=1500)
        result = await client.outcome(good=False)
        assert result.applied >= 1
        assert result.ids is not None
        assert mem.id in result.ids


async def test_get_context_budget_zero_short_circuits(hippo_server: str, hippo_member_key: str):
    async with Hippo(base_url=hippo_server, api_key=hippo_member_key) as client:
        await client.remember(content="budget-zero canary")
        ctx = await client.get_context(budget=0)
        assert ctx.entries == []
        assert ctx.tokens == 0


async def test_get_context_pinned_only_empty_store(hippo_server: str, hippo_member_key: str):
    async with Hippo(base_url=hippo_server, api_key=hippo_member_key) as client:
        ctx = await client.get_context(pinned_only=True, budget=1500)
        assert ctx.entries == []


async def test_sleep_dry_run(hippo_server: str, hippo_admin_key: str):
    async with Hippo(base_url=hippo_server, api_key=hippo_admin_key) as client:
        await client.remember(content="sleep-dry-run canary")
        result = await client.sleep(dry_run=True)
        assert result.dry_run is True


async def test_forget_removes_memory(hippo_server: str, hippo_admin_key: str):
    async with Hippo(base_url=hippo_server, api_key=hippo_admin_key) as client:
        mem = await client.remember(content="forget-target canary")
        result = await client.forget(mem.id)
        assert result.ok is True
        assert result.id == mem.id


async def test_member_forget_of_unowned_row_is_403(hippo_server: str, hippo_member_key: str):
    async with Hippo(base_url=hippo_server, api_key=hippo_member_key) as client:
        mem = await client.remember(content="member-forget canary")
        with pytest.raises(HippoError) as exc_info:
            await client.forget(mem.id)
        assert exc_info.value.status_code == 403
        assert "admin key" in str(exc_info.value)


async def test_hippo_error_on_400(hippo_server: str, hippo_member_key: str):
    async with Hippo(base_url=hippo_server, api_key=hippo_member_key) as client:
        with pytest.raises(HippoError) as exc_info:
            await client._request("POST", "/v1/outcome", json={"good": "not-a-bool"})
        assert exc_info.value.status_code == 400
