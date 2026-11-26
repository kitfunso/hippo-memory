from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

import hippo
from hippo_cases import UNICODE, capture_names, hook_reply, recall_reply, same_path, session, transcript_lines


def test_prefetch_sends_the_hook_payload_on_stdin(fake, start, env, started):
    fake.answer("context", out=hook_reply(f"Pinned rules\n- {UNICODE}"))
    provider = start(session_id="s1")
    assert provider.prefetch(f"deploy {UNICODE}") == f"Pinned rules\n- {UNICODE}"
    provider.prefetch("next step", session_id="hermes-7")
    first, second = fake.calls("context")
    assert first["args"] == [*hippo.CONTEXT_ARGS, "--global"]
    assert json.loads(first["stdin"]) == {"session_id": "s1", "prompt": f"deploy {UNICODE}"}
    assert json.loads(second["stdin"])["session_id"] == "hermes-7"
    assert first["stdinKind"] == "pipe" and same_path(first["cwd"], env.home)
    assert started[0].kwargs["stdin"] is subprocess.PIPE and started[0].kwargs["encoding"] == "utf-8"
    assert "shell" not in started[0].kwargs


def test_recall_puts_the_query_after_a_double_dash(fake, start, env, started):
    fake.answer("recall", out=json.dumps({"results": [{"id": "mem_a", "content": UNICODE}]}, ensure_ascii=False))
    provider = start()
    result = json.loads(provider.handle_tool_call("hippo_recall", {"query": f"--pin {UNICODE}"}))
    assert result == {"results": [{"id": "mem_a", "content": UNICODE}], "total": 1}
    [call] = fake.calls("recall")
    assert call["args"] == [*hippo.RECALL_ARGS, "--global", "--", f"--pin {UNICODE}"]
    assert call["stdinKind"] == "devnull" and same_path(call["cwd"], env.home)
    assert started[0].kwargs["stdin"] is subprocess.DEVNULL


def test_remember_tags_the_text_and_puts_it_after_a_double_dash(fake, start, env):
    fake.answer("remember", out="[global] Remembered [mem_x]\n")
    provider = start()
    result = json.loads(provider.handle_tool_call("hippo_remember", {"text": f"-x {UNICODE}"}))
    assert result == {"result": "[global] Remembered [mem_x]"}
    [call] = fake.calls("remember")
    assert call["args"] == [*hippo.REMEMBER_ARGS, "--global", "--", f"-x {UNICODE}"]
    assert call["stdinKind"] == "devnull" and same_path(call["cwd"], env.home)


def test_outcome_marks_every_id_of_the_last_recall_in_one_call(fake, start, env):
    fake.answer("recall", out=recall_reply("mem_a", "mem_b"))
    fake.answer("outcome", out="Applied positive outcome to 2 memories\n")
    provider = start()
    provider.handle_tool_call("hippo_recall", {"query": "deploy"})
    assert json.loads(provider.handle_tool_call("hippo_outcome", {"good": True})) == {
        "result": "Applied positive outcome to 2 memories"}
    [call] = fake.calls("outcome")
    assert call["args"] == ["--good", "--id", "mem_a", "--id", "mem_b", "--global"]
    assert call["stdinKind"] == "devnull" and same_path(call["cwd"], env.home)
    assert "error" in json.loads(provider.handle_tool_call("hippo_outcome", {"good": False}))
    assert "error" in json.loads(provider.handle_tool_call("hippo_outcome", {"good": "yes"}))
    assert len(fake.calls("outcome")) == 1


def test_capture_names_the_file_for_the_session_and_deletes_it(fake, start, env):
    provider = start(session_id="a/b:c")
    provider.on_session_end(session(f"keep {UNICODE}", "kept"))
    provider.shutdown()
    [call] = fake.calls("capture")
    path = Path(call["args"][1])
    assert call["args"] == ["--transcript", str(path), "--global"]
    assert capture_names(fake) == ["a_b_c.jsonl"]
    assert transcript_lines(call) == [{"role": "user", "content": f"keep {UNICODE}"},
                                      {"role": "assistant", "content": "kept"}]
    assert call["stdinKind"] == "devnull" and same_path(call["cwd"], env.home)
    assert not path.exists() and not path.parent.exists()


def test_a_failed_verb_gives_an_error_and_no_recall_ids(fake, start):
    fake.answer("recall", out="", code=1)
    provider = start()
    assert "error" in json.loads(provider.handle_tool_call("hippo_recall", {"query": "deploy"}))
    assert "error" in json.loads(provider.handle_tool_call("hippo_recall", {"query": "  "}))
    assert "error" in json.loads(provider.handle_tool_call("hippo_outcome", {"good": True}))
    assert len(fake.calls("recall")) == 1


@pytest.mark.parametrize("verb", list(hippo.TIMEOUTS))
def test_each_verb_stops_at_its_time_limit(verb, fake, monkeypatch):
    monkeypatch.setitem(hippo.TIMEOUTS, verb, 1)
    fake.answer(verb, sleep=30)
    procs = []
    began = time.monotonic()
    assert hippo.run_hippo(verb, [], stdin="{}" if verb == "context" else None, on_start=procs.append) is None
    assert time.monotonic() - began < 10
    assert procs[0].returncode is not None
    assert len(fake.calls(verb)) == 1


@pytest.mark.parametrize("name", ["hippo.cmd", "HIPPO.BAT"])
def test_windows_refuses_a_batch_file(name, tmp_path, monkeypatch, started):
    monkeypatch.setenv("HIPPO_BIN", str(tmp_path / name))
    monkeypatch.setattr(sys, "platform", "win32")
    with pytest.raises(ValueError):
        hippo.launcher()
    assert hippo.run_hippo("recall", [], text="x") is None
    assert not hippo.HippoProvider().is_available()
    assert started == []


def test_a_js_bin_runs_under_node(tmp_path, monkeypatch):
    script = tmp_path / "hippo.js"
    monkeypatch.setenv("HIPPO_BIN", str(script))
    assert hippo.launcher() == ["node", str(script)]
    hippo.LAUNCHER_FILE.write_text(json.dumps({"node": sys.executable, "script": str(script)}), encoding="utf-8")
    assert hippo.launcher() == [sys.executable, str(script)]
    exe = tmp_path / "hippo.exe"
    monkeypatch.setenv("HIPPO_BIN", str(exe))
    assert hippo.launcher() == [str(exe)]


def test_launcher_json_with_a_moved_node_falls_back_to_node_on_path(tmp_path):
    script = tmp_path / "hippo.js"
    script.write_text("", encoding="utf-8")
    gone = tmp_path / "gone" / "node.exe"
    hippo.LAUNCHER_FILE.write_text(json.dumps({"node": str(gone), "script": str(script)}), encoding="utf-8")
    assert hippo.launcher() == ["node", str(script)]
    script.unlink()
    assert hippo.launcher() == ["hippo"]


def test_is_available_reads_paths_and_starts_no_process(fake, tmp_path, monkeypatch, started):
    assert hippo.HippoProvider().is_available()
    monkeypatch.setenv("HIPPO_BIN", str(tmp_path / "missing" / "hippo.js"))
    assert not hippo.HippoProvider().is_available()
    monkeypatch.delenv("HIPPO_BIN")
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    assert not hippo.HippoProvider().is_available()
    assert started == []
