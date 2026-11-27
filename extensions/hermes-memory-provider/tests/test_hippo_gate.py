from __future__ import annotations

import json
import logging
import threading

import pytest
from agent.memory_manager import MemoryManager

import hippo
from hippo_cases import hook_reply, recall_reply, session, transcript_lines, write_config

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
    ("desktop", None, [], {"HERMES_SESSION_SOURCE": "desktop"}, NONE),
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


@pytest.mark.parametrize(("policy_source", "platform", "opt_in", "expected"), [
    ("tool", "cli", [], NONE),
    ("tool", "cli", ["tool"], ALL),
    ("acp", "cli", [], NONE),
    ("gui", "desktop", [], NONE),
    ("gui", "desktop", ["desktop"], ALL),
    ("oneshot", "cli", [], ALL),
])
def test_gateway_session_policy_gates_global_memory(policy_source, platform, opt_in, expected, env, start, started):
    from gateway import session_policy

    write_config(env.hermes_home, f"memory:\n  hippo:\n    platforms: {json.dumps(opt_in)}\n")
    policy = session_policy.LocalSessionPolicy(
        source=policy_source,
        platform=platform,
        cwd=str(env.home),
        model=None,
        toolsets=(),
        config_json="{}",
        request_json=json.dumps({"source": policy_source}),
        terminal_json="{}",
    )
    token = session_policy._ACTIVE_POLICY.set(policy)
    try:
        provider = start(platform=platform)
        assert {op: provider.allowed(op) for op in hippo.OPS} == expected
        shown = {hippo.TOOL_OPS[name] for name in names(provider.get_tool_schemas())}
        assert shown == {op for op in ("recall", "remember", "outcome") if expected[op]}
        if expected == NONE:
            assert provider.prefetch("deploy") == ""
            provider.on_session_end(session("gateway tool turn"))
            provider.shutdown()
            assert started == []
    finally:
        session_policy._ACTIVE_POLICY.reset(token)


def test_isolated_plugin_host_fails_closed_without_session_policy(env, start, started, monkeypatch, caplog):
    from hermes_cli import plugin_events

    monkeypatch.setattr(plugin_events, "_session_event_forwarder", lambda *a: True)
    with caplog.at_level(logging.WARNING):
        provider = start(platform="cli")
    assert {op: provider.allowed(op) for op in hippo.OPS} == NONE
    assert not names(provider.get_tool_schemas()) & TOOLS
    assert provider.prefetch("deploy") == ""
    provider.on_session_end(session("hosted tool turn"))
    provider.shutdown()
    assert started == []
    assert any("plugins.isolation: host" in r.getMessage() for r in caplog.records)


def test_isolated_plugin_host_obeys_active_policy_when_bound(env, start, monkeypatch):
    from gateway import session_policy
    from hermes_cli import plugin_events

    monkeypatch.setattr(plugin_events, "_session_event_forwarder", lambda *a: True)
    policy = session_policy.LocalSessionPolicy(
        source="cli",
        platform="cli",
        cwd=str(env.home),
        model=None,
        toolsets=(),
        config_json="{}",
        request_json=json.dumps({"source": "cli"}),
        terminal_json="{}",
    )
    token = session_policy._ACTIVE_POLICY.set(policy)
    try:
        provider = start(platform="cli")
        assert {op: provider.allowed(op) for op in hippo.OPS} == ALL
    finally:
        session_policy._ACTIVE_POLICY.reset(token)


def test_opting_out_a_platform_revokes_access_and_changes_identity_signature(env, start, started):
    write_config(env.hermes_home, "memory:\n  hippo:\n    platforms: [telegram]\n")
    provider = start(platform="telegram")
    assert provider.identity_signature() == {"hippo_platforms": ["telegram"]}
    assert {op: provider.allowed(op) for op in hippo.OPS} == ALL

    write_config(env.hermes_home, "memory:\n  hippo:\n    platforms: []\n")
    assert provider.identity_signature() == {"hippo_platforms": []}
    assert {op: provider.allowed(op) for op in hippo.OPS} == NONE
    assert not names(provider.get_tool_schemas()) & TOOLS
    assert provider.prefetch("deploy") == ""
    provider.on_session_end(session("revoked telegram turn"))
    provider.shutdown()
    assert started == []


def test_invalid_config_yaml_fails_closed_without_cached_fallback(env, start, caplog):
    write_config(env.hermes_home, "memory:\n  hippo:\n    platforms: [telegram]\n")
    provider = start(platform="telegram")
    assert provider.identity_signature() == {"hippo_platforms": ["telegram"]}
    assert provider.allowed("recall")

    write_config(env.hermes_home, "memory: [\n")
    with caplog.at_level(logging.WARNING):
        assert provider.identity_signature() == {"hippo_platforms": []}
        assert not provider.allowed("recall")
    assert any("could not be parsed" in r.getMessage() for r in caplog.records)


def test_queued_capture_skips_when_platform_is_opted_out_before_worker_runs(fake, env, start, monkeypatch):
    write_config(env.hermes_home, "memory:\n  hippo:\n    platforms: [telegram]\n")
    entered, release = threading.Event(), threading.Event()
    real_write = hippo.write_chat_lines
    written = []

    def held_write(lines, path):
        written.append(lines)
        entered.set()
        release.wait(timeout=15)
        real_write(lines, path)

    monkeypatch.setattr(hippo, "write_chat_lines", held_write)
    provider = start(platform="telegram")
    provider.on_session_end(session("first telegram turn"))
    assert entered.wait(timeout=15)
    provider.on_session_end(session("second telegram turn"))
    write_config(env.hermes_home, "memory:\n  hippo:\n    platforms: []\n")
    release.set()
    provider.shutdown()
    calls = fake.calls("capture")
    assert len(calls) == 1
    assert len(written) == 1
    assert transcript_lines(calls[0])[0]["content"] == "first telegram turn"


def test_switching_tenant_mid_session_skips_capture(fake, start, started, monkeypatch, caplog):
    provider = start()
    monkeypatch.setenv("HIPPO_TENANT", "work")
    with caplog.at_level(logging.WARNING):
        provider.on_session_end(session("work tenant turn"))
        provider.shutdown()
    assert started == []
    assert fake.calls("capture") == []
    assert any("HIPPO_TENANT is work" in r.getMessage() for r in caplog.records)


def test_queued_capture_skips_when_tenant_changes_before_worker_runs(
        fake, start, started, monkeypatch, caplog):
    entered, release = threading.Event(), threading.Event()
    real_write = hippo.write_chat_lines
    written = []

    def held_write(lines, path):
        written.append(lines)
        entered.set()
        release.wait(timeout=15)
        real_write(lines, path)

    monkeypatch.setattr(hippo, "write_chat_lines", held_write)
    provider = start()
    provider.on_session_end(session("default tenant turn"))
    assert entered.wait(timeout=15)
    provider.on_session_end(session("queued turn before switch"))
    monkeypatch.setenv("HIPPO_TENANT", "work")
    with caplog.at_level(logging.WARNING):
        release.set()
        provider.shutdown()
    assert len(started) == 1
    assert len(written) == 1
    calls = fake.calls("capture")
    assert len(calls) == 1
    assert transcript_lines(calls[0])[0]["content"] == "default tenant turn"
    assert any("HIPPO_TENANT is work" in r.getMessage() for r in caplog.records)


def test_capture_child_receives_checked_env_snapshot_without_toctou(fake, start, started, monkeypatch):
    real_write = hippo.write_chat_lines

    def switch_tenant_after_check(lines, path):
        monkeypatch.setenv("HIPPO_TENANT", "work")
        real_write(lines, path)

    monkeypatch.setattr(hippo, "write_chat_lines", switch_tenant_after_check)
    provider = start()
    provider.on_session_end(session("checked snapshot turn"))
    provider.shutdown()
    assert len(started) == 1
    child_env = started[0].kwargs["env"]
    assert child_env is not None
    assert child_env.get("HIPPO_TENANT", "") == ""
    [call] = fake.calls("capture")
    assert call["tenant"] is None


def test_non_primary_reads_pass_read_only_and_skip_auto_integrations(fake, env, start, started):
    fake.answer("context", out=hook_reply("Pinned"))
    fake.answer("recall", out=recall_reply("mem_a"))
    write_config(env.hermes_home, "memory:\n  hippo:\n    platforms: [cron, subagent]\n")

    cron = start(platform="cron", agent_context="cron")
    assert cron.prefetch("deploy") == "Pinned"
    assert json.loads(cron.handle_tool_call("hippo_recall", {"query": "deploy"}))["total"] == 1
    subagent = start(platform="subagent", agent_context="subagent")
    assert json.loads(subagent.handle_tool_call("hippo_recall", {"query": "deploy"}))["total"] == 1
    assert len(started) == 3
    for entry in started:
        assert entry.kwargs["env"]["HIPPO_READ_ONLY"] == "1"
        assert entry.kwargs["env"]["HIPPO_SKIP_AUTO_INTEGRATIONS"] == "1"

    cli = start(platform="cli")
    cli.prefetch("deploy")
    assert started[3].kwargs["env"] is None


def test_remote_and_unproven_desktop_require_opt_in_while_local_owner_is_allowed(env, start, monkeypatch):
    from gateway import session_policy
    from hermes_cli.process_identity import serving_local_desktop

    monkeypatch.setenv("HERMES_SESSION_SOURCE", "desktop")
    unproven = start(platform="desktop")
    assert {op: unproven.allowed(op) for op in hippo.OPS} == NONE

    with serving_local_desktop(True):
        local_ctx = start(platform="desktop")
        assert {op: local_ctx.allowed(op) for op in hippo.OPS} == ALL

    monkeypatch.delenv("HERMES_SESSION_SOURCE")

    def make_policy(config_json: str = "{}") -> session_policy.LocalSessionPolicy:
        return session_policy.LocalSessionPolicy(
            source="gui",
            platform="desktop",
            cwd=str(env.home),
            model=None,
            toolsets=(),
            config_json=config_json,
            request_json="{}",
            terminal_json="{}",
        )

    token = session_policy._ACTIVE_POLICY.set(make_policy())
    try:
        remote = start(platform="desktop")
        assert {op: remote.allowed(op) for op in hippo.OPS} == NONE
        write_config(env.hermes_home, "memory:\n  hippo:\n    platforms: [desktop]\n")
        assert {op: remote.allowed(op) for op in hippo.OPS} == ALL
    finally:
        session_policy._ACTIVE_POLICY.reset(token)

    write_config(env.hermes_home, "memory:\n  hippo:\n    platforms: []\n")
    token = session_policy._ACTIVE_POLICY.set(make_policy(json.dumps({"desktop_local": True})))
    try:
        owner_policy = start(platform="desktop")
        assert {op: owner_policy.allowed(op) for op in hippo.OPS} == ALL
    finally:
        session_policy._ACTIVE_POLICY.reset(token)

    token = session_policy._ACTIVE_POLICY.set(make_policy())
    try:
        with serving_local_desktop(True):
            owner_ctx = start(platform="desktop")
            assert {op: owner_ctx.allowed(op) for op in hippo.OPS} == ALL
    finally:
        session_policy._ACTIVE_POLICY.reset(token)
