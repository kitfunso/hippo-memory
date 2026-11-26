from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time

import pytest
from agent.memory_manager import MemoryManager
from session_rules.turns import SUMMARY_PREFIX, _MERGED_PRIOR_CONTEXT_HEADER, _MERGED_SUMMARY_DELIMITER

import hippo
from hippo_cases import PLUGIN_ROOT, capture_names, recall_reply, session, transcript_lines, wait_for

EXIT_SCRIPT = """
import logging, sys, time
logging.basicConfig(level=logging.WARNING)
import hippo
hippo.CAPTURE_DEADLINE_S = 2
provider = hippo.HippoProvider()
provider.initialize("s1", platform="cli", hermes_home=sys.argv[1])
provider.on_session_end([{"role": "user", "content": "first ask"}])
deadline = time.monotonic() + 15
while "capture" not in open(sys.argv[2], encoding="utf-8").read() and time.monotonic() < deadline:
    time.sleep(0.05)
provider.on_session_end([{"role": "user", "content": "second ask"}])
"""


def manager_for(env, session_id: str = "s1") -> MemoryManager:
    manager = MemoryManager()
    manager.add_provider(hippo.HippoProvider())
    manager.initialize_all(session_id, platform="cli", hermes_home=str(env.hermes_home))
    return manager


def test_new_session_captures_the_old_id_then_the_new_one(fake, env):
    manager = manager_for(env)
    manager.commit_session_boundary_async(session("first ask"), new_session_id="s2")
    assert manager.flush_pending(timeout=10)
    manager.on_session_end(session("second ask"))
    manager.shutdown_all()
    assert capture_names(fake) == ["s1.jsonl", "s2.jsonl"]
    first, second = (transcript_lines(call)[0]["content"] for call in fake.calls("capture"))
    assert (first, second) == ("first ask", "second ask")


def test_compression_captures_parent_then_child_and_keeps_the_recall(fake, env):
    fake.answer("recall", out=recall_reply("mem_a", "mem_b"))
    manager = manager_for(env, "parent")
    manager.handle_tool_call("hippo_recall", {"query": "deploy"})
    manager.on_session_end(session("parent ask"))
    manager.on_session_switch("child", parent_session_id="parent", reset=False, reason="compression")
    manager.on_session_end(session("child ask"))
    assert "result" in json.loads(manager.handle_tool_call("hippo_outcome", {"good": True}))
    manager.shutdown_all()
    assert capture_names(fake) == ["parent.jsonl", "child.jsonl"]
    [outcome] = fake.calls("outcome")
    assert outcome["args"] == ["--good", "--id", "mem_a", "--id", "mem_b", "--global"]


def test_in_place_compaction_captures_one_id_twice(fake, env):
    manager = manager_for(env)
    manager.on_session_end(session("keep the linter rule"))
    manager.on_session_switch("s1", parent_session_id="s1", reset=False, reason="compression")
    carrier = (f"{_MERGED_PRIOR_CONTEXT_HEADER}\nkeep the linter rule\n\n{_MERGED_SUMMARY_DELIMITER}\n\n"
               f"{SUMMARY_PREFIX}\nsummary body words")
    manager.on_session_end([{"role": "user", "content": carrier}, {"role": "assistant", "content": "On it."}])
    manager.shutdown_all()
    assert capture_names(fake) == ["s1.jsonl", "s1.jsonl"]
    assert transcript_lines(fake.calls("capture")[1]) == [{"role": "user", "content": "keep the linter rule"},
                                                          {"role": "assistant", "content": "On it."}]


@pytest.mark.parametrize("switch", [{"reset": True, "reason": "new_session"}, {"reset": False}],
                         ids=["reset", "resume"])
def test_a_switch_to_another_conversation_forgets_the_recall(switch, fake, start, started):
    fake.answer("recall", out=recall_reply("mem_a"))
    provider = start()
    provider.handle_tool_call("hippo_recall", {"query": "deploy"})
    provider.on_session_switch("s2", **switch)
    assert "error" in json.loads(provider.handle_tool_call("hippo_outcome", {"good": True}))
    assert [entry.argv[2] for entry in started] == ["recall"]


def test_a_rewind_keeps_the_session_and_the_recall(fake, start):
    fake.answer("recall", out=recall_reply("mem_a"))
    provider = start()
    provider.handle_tool_call("hippo_recall", {"query": "deploy"})
    provider.on_session_switch("s1", rewound=True)
    provider.handle_tool_call("hippo_outcome", {"good": False})
    provider.on_session_end(session("an ask"))
    provider.shutdown()
    assert fake.calls("outcome")[0]["args"] == ["--bad", "--id", "mem_a", "--global"]
    assert capture_names(fake) == ["s1.jsonl"]


def test_shutdown_stops_a_stuck_capture_and_drops_the_queue(fake, start, started, monkeypatch, caplog):
    monkeypatch.setattr(hippo, "CAPTURE_DEADLINE_S", 2)
    fake.answer("capture", sleep=60)
    provider = start()
    provider.on_session_end(session("first ask"))
    wait_for(lambda: len(fake.calls("capture")) == 1)
    provider.on_session_end(session("second ask"))
    began = time.monotonic()
    with caplog.at_level(logging.WARNING):
        provider.shutdown()
    assert time.monotonic() - began < 4
    assert started[0].proc.wait(timeout=5) is not None
    time.sleep(1)
    assert len(fake.calls("capture")) == 1
    assert any("stopped 1 running and dropped 1 queued" in r.getMessage() for r in caplog.records)
    provider.on_session_end(session("late ask"))
    assert len(started) == 1


def test_exit_without_shutdown_still_runs_the_deadline(fake, env):
    fake.answer("capture", sleep=60)
    path = os.pathsep.join([str(PLUGIN_ROOT), os.environ.get("PYTHONPATH", "")])
    began = time.monotonic()
    done = subprocess.run([sys.executable, "-c", EXIT_SCRIPT, str(env.hermes_home), str(fake.log)],
                          capture_output=True, text=True, timeout=60, env={**os.environ, "PYTHONPATH": path})
    assert time.monotonic() - began < 20
    assert done.returncode == 0, done.stderr
    assert "stopped 1 running and dropped 1 queued" in done.stderr
    assert len(fake.calls("capture")) == 1
