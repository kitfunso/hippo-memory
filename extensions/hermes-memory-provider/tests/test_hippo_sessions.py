from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading

import pytest
from agent.memory_manager import _SYNC_DRAIN_TIMEOUT_S, MemoryManager
from session_rules.turns import SUMMARY_PREFIX, _MERGED_PRIOR_CONTEXT_HEADER, _MERGED_SUMMARY_DELIMITER

import hippo
from hippo_cases import PLUGIN_ROOT, capture_names, recall_reply, session, transcript_lines, wait_for

HERMES_FLUSH_PENDING_S = 10
STUCK_GUARD_S = 30
EXIT_RUN_GUARD_S = 60
CAPTURE_TIMEOUT_S = 300
CAPTURE_SLEEP_S = 600
assert STUCK_GUARD_S < EXIT_RUN_GUARD_S < CAPTURE_TIMEOUT_S < CAPTURE_SLEEP_S

EXIT_SCRIPT = """
import logging, sys, time
logging.basicConfig(level=logging.WARNING)
import hippo
hippo.TIMEOUTS["capture"] = int(sys.argv[3])
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


@pytest.mark.parametrize(
    ("watchdog", "deadline"),
    [(None, 12), ("60", 42), ("0", 30), ("-5", 30), ("junk", 12), ("10", 1), ("inf", 30), ("nan", 30)])
def test_the_capture_deadline_follows_the_hermes_exit_watchdog(watchdog, deadline, monkeypatch):
    if watchdog is not None:
        monkeypatch.setenv("HERMES_EXIT_WATCHDOG_S", watchdog)
    assert hippo.capture_deadline_s() == deadline


@pytest.mark.parametrize("watchdog", [19, 19.5, 20, 30, 45, 60, 300, 3600])
def test_the_capture_deadline_ends_before_the_hermes_exit_watchdog(watchdog, monkeypatch):
    monkeypatch.setenv("HERMES_EXIT_WATCHDOG_S", str(watchdog))
    spent = hippo.capture_deadline_s() + hippo.HERMES_PRE_SHUTDOWN_S + hippo.SHUTDOWN_MARGIN_S
    assert spent <= watchdog


@pytest.mark.parametrize("watchdog", ["1e7", "1e12", "1e300"])
def test_a_huge_exit_watchdog_never_gives_a_deadline_the_os_refuses(watchdog, monkeypatch):
    monkeypatch.setenv("HERMES_EXIT_WATCHDOG_S", watchdog)
    deadline = hippo.capture_deadline_s()
    held_back = hippo.HERMES_PRE_SHUTDOWN_S + hippo.SHUTDOWN_MARGIN_S
    assert deadline == min(float(watchdog) - held_back, threading.TIMEOUT_MAX)
    assert threading.Lock().acquire(timeout=deadline)


def test_the_pre_shutdown_allowance_covers_the_hermes_flush_and_drain():
    assert hippo.HERMES_PRE_SHUTDOWN_S >= HERMES_FLUSH_PENDING_S + _SYNC_DRAIN_TIMEOUT_S


def test_shutdown_stops_a_stuck_capture_and_drops_the_queue(fake, start, started, submitted, monkeypatch, caplog):
    monkeypatch.setenv("HERMES_EXIT_WATCHDOG_S", "19")
    monkeypatch.setitem(hippo.TIMEOUTS, "capture", CAPTURE_TIMEOUT_S)
    waits = []
    real_wait = hippo.wait

    def recording_wait(futures, timeout=None):
        waits.append(timeout)
        return real_wait(futures, timeout=timeout)

    monkeypatch.setattr(hippo, "wait", recording_wait)
    fake.answer("capture", sleep=CAPTURE_SLEEP_S)
    provider = start()
    provider.on_session_end(session("first ask"))
    wait_for(lambda: len(fake.calls("capture")) == 1)
    provider.on_session_end(session("second ask"))
    with caplog.at_level(logging.WARNING):
        provider.shutdown()
    assert waits == [1.0]
    assert started[0].proc.wait(timeout=STUCK_GUARD_S) != 0
    submitted[0].result(timeout=STUCK_GUARD_S)
    assert [future.cancelled() for future in submitted] == [False, True]
    assert len(fake.calls("capture")) == 1
    assert any("stopped 1 running and dropped 1 queued" in r.getMessage() for r in caplog.records)
    provider.on_session_end(session("late ask"))
    assert len(started) == 1


def test_shutdown_counts_a_capture_that_reaches_its_process_after_the_deadline(
        fake, start, started, submitted, monkeypatch, caplog):
    monkeypatch.setenv("HERMES_EXIT_WATCHDOG_S", "19")
    monkeypatch.setitem(hippo.TIMEOUTS, "capture", CAPTURE_TIMEOUT_S)
    entered, release = threading.Event(), threading.Event()
    real_write = hippo.write_chat_lines

    def held_write(lines, path):
        entered.set()
        release.wait(timeout=STUCK_GUARD_S)
        real_write(lines, path)

    monkeypatch.setattr(hippo, "write_chat_lines", held_write)
    fake.answer("capture", sleep=CAPTURE_SLEEP_S)
    provider = start()
    provider.on_session_end(session("first ask"))
    assert entered.wait(timeout=STUCK_GUARD_S)
    with caplog.at_level(logging.WARNING):
        provider.shutdown()
    release.set()
    submitted[0].result(timeout=STUCK_GUARD_S)
    assert len(started) == 1
    assert started[0].proc.wait(timeout=STUCK_GUARD_S) != 0
    assert any("stopped 1 running and dropped 0 queued" in r.getMessage() for r in caplog.records)


def test_a_capture_job_that_crashes_is_logged(fake, start, monkeypatch, caplog):
    def broken_write(lines, path):
        raise RuntimeError("disk exploded")

    monkeypatch.setattr(hippo, "write_chat_lines", broken_write)
    provider = start()
    with caplog.at_level(logging.ERROR):
        provider.on_session_end(session("an ask"))
        provider.shutdown()
        wait_for(lambda: any("disk exploded" in r.getMessage() for r in caplog.records))
    assert fake.calls("capture") == []


def test_exit_without_shutdown_still_runs_the_deadline(fake, env):
    fake.answer("capture", sleep=CAPTURE_SLEEP_S)
    path = os.pathsep.join([str(PLUGIN_ROOT), os.environ.get("PYTHONPATH", "")])
    args = [sys.executable, "-c", EXIT_SCRIPT, str(env.hermes_home), str(fake.log), str(CAPTURE_TIMEOUT_S)]
    done = subprocess.run(args, capture_output=True, text=True, timeout=EXIT_RUN_GUARD_S,
                          env={**os.environ, "PYTHONPATH": path, "HERMES_EXIT_WATCHDOG_S": "20"})
    assert done.returncode == 0, done.stderr
    assert "stopped 1 running and dropped 1 queued" in done.stderr
    assert len(fake.calls("capture")) == 1
