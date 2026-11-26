from __future__ import annotations

import json
import logging

import pytest
from agent.memory_manager import MemoryManager

import hippo
from hippo_cases import hook_reply, recall_reply, session, write_config

ALL = dict.fromkeys(hippo.OPS, True)
NONE = dict.fromkeys(hippo.OPS, False)
TOOLS = set(hippo.TOOL_OPS)


def only(*ops: str) -> dict[str, bool]:
    return {op: op in ops for op in hippo.OPS}


def names(schemas: list[dict]) -> set[str]:
    return {schema["name"] for schema in schemas}


def manager_on(env, platform: str) -> MemoryManager:
    manager = MemoryManager()
    manager.add_provider(hippo.HippoProvider())
    manager.initialize_all("s1", platform=platform, hermes_home=str(env.hermes_home))
    return manager


def test_the_real_manager_routes_hippo_tools_on_a_local_chat(fake, env):
    fake.answer("recall", out=recall_reply("mem_a"))
    manager = manager_on(env, "cli")
    assert manager.has_tool("hippo_recall")
    assert TOOLS <= names(manager.get_all_tool_schemas())
    result = json.loads(manager.handle_tool_call("hippo_recall", {"query": "staging"}))
    assert result == {"results": [{"id": "mem_a", "content": "memory mem_a"}], "total": 1}
    assert len(fake.calls("recall")) == 1
    manager.shutdown_all()


def test_the_real_manager_shows_no_hippo_tool_in_a_gateway_chat(fake, env, started):
    manager = manager_on(env, "telegram")
    assert not names(manager.get_all_tool_schemas()) & TOOLS
    refused = json.loads(manager.handle_tool_call("hippo_recall", {"query": "staging"}))
    assert refused == {"error": "hippo is off for telegram/primary"}
    assert manager.prefetch_all("how do I deploy") == ""
    manager.on_session_end(session("a gateway turn"))
    manager.shutdown_all()
    assert started == []


def test_every_tool_is_listed_before_initialize():
    assert names(hippo.HippoProvider().get_tool_schemas()) == TOOLS


GATE_CASES = [
    ("cli", None, [], {}, ALL),
    ("tui", None, [], {"HERMES_SESSION_SOURCE": "tui"}, ALL),
    ("desktop", None, [], {"HERMES_SESSION_SOURCE": "desktop"}, ALL),
    ("cli", None, [], {"HERMES_SINGLE_QUERY_SESSION": "1"}, ALL),
    ("cli", "subagent", [], {}, only("recall")),
    ("cli", "flush", [], {}, NONE),
    ("cli", "curator", [], {}, only("recall")),
    ("cron", "cron", [], {}, NONE),
    ("cron", "cron", ["cron"], {}, only("prefetch", "recall")),
    ("subagent", "subagent", [], {}, NONE),
    ("subagent", "subagent", ["subagent"], {}, only("recall")),
    ("telegram", None, [], {}, NONE),
    ("telegram", None, ["Telegram"], {}, ALL),
    ("cli", None, [], {"HERMES_SESSION_SOURCE": "kanban"}, NONE),
    ("cli", None, [], {"HERMES_SESSION_SOURCE": "tool"}, NONE),
    ("cli", None, ["kanban"], {"HERMES_SESSION_SOURCE": "kanban"}, ALL),
]


@pytest.mark.parametrize(("platform", "context", "opt_in", "source_env", "expected"), GATE_CASES)
def test_the_gate_for_each_platform_and_context(platform, context, opt_in, source_env, expected, env, start,
                                                monkeypatch):
    write_config(env.hermes_home, f"memory:\n  hippo:\n    platforms: {json.dumps(opt_in)}\n")
    for key, value in source_env.items():
        monkeypatch.setenv(key, value)
    provider = start(platform=platform, **({"agent_context": context} if context else {}))
    assert {op: provider.allowed(op) for op in hippo.OPS} == expected
    shown = {hippo.TOOL_OPS[name] for name in names(provider.get_tool_schemas())}
    assert shown == {op for op in ("recall", "remember", "outcome") if expected[op]}


def test_a_refused_tool_call_names_the_platform_and_starts_nothing(fake, start, started):
    provider = start(platform="cron", agent_context="cron")
    result = json.loads(provider.handle_tool_call("hippo_remember", {"text": "a fact"}))
    assert result == {"error": "hippo is off for cron/cron"}
    assert provider.prefetch("how do I deploy") == ""
    assert started == []


def test_a_platforms_value_that_is_not_a_list_opts_nothing_in(env, start, caplog):
    write_config(env.hermes_home, "memory:\n  hippo:\n    platforms: telegram\n")
    with caplog.at_level(logging.WARNING):
        provider = start(platform="telegram")
    assert not provider.allowed("recall")
    assert any("must be a list" in r.getMessage() for r in caplog.records)


def test_another_tenant_turns_capture_off_with_one_warning(fake, start, started, caplog, monkeypatch):
    monkeypatch.setenv("HIPPO_TENANT", "beta")
    fake.answer("context", out=hook_reply("Pinned rules"))
    with caplog.at_level(logging.WARNING):
        provider = start()
        provider.on_session_end(session("first ask"))
        provider.on_session_end(session("second ask"))
        provider.shutdown()
    warnings = [r.getMessage() for r in caplog.records if r.name == hippo.logger.name]
    assert len(warnings) == 1 and "HIPPO_TENANT is beta" in warnings[0]
    assert started == []
    assert provider.prefetch("deploy") == "Pinned rules"
    assert [call["tenant"] for call in fake.calls()] == ["beta"]


def test_the_default_tenant_keeps_capture_on(fake, start, monkeypatch):
    monkeypatch.setenv("HIPPO_TENANT", "default")
    provider = start()
    provider.on_session_end(session("an ask"))
    provider.shutdown()
    assert len(fake.calls("capture")) == 1
