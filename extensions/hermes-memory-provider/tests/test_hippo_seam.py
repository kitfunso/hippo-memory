from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

import hippo
from hippo_cases import (UNICODE, capture_names, hook_reply, recall_reply, remember_reply, same_path, session,
                         transcript_lines)


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
    fake.answer("remember", out=remember_reply("mem_x"))
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


def test_a_failed_recall_clears_previous_recall_ids(fake, start):
    fake.answer("recall", out=recall_reply("mem_old"))
    provider = start()
    first = json.loads(provider.handle_tool_call("hippo_recall", {"query": "first"}))
    assert first["total"] == 1
    fake.answer("recall", out="", code=1)
    assert "error" in json.loads(provider.handle_tool_call("hippo_recall", {"query": "second"}))
    assert "error" in json.loads(provider.handle_tool_call("hippo_outcome", {"good": True}))
    assert fake.calls("outcome") == []


@pytest.mark.parametrize("verb", list(hippo.TIMEOUTS))
def test_each_verb_stops_at_its_time_limit(verb, fake, monkeypatch):
    monkeypatch.setitem(hippo.TIMEOUTS, verb, 1)
    fake.answer(verb, sleep=30)
    procs = []
    assert hippo.run_hippo(verb, [], stdin="{}" if verb == "context" else None, on_start=procs.append) is None
    assert len(procs) == 1 and procs[0].returncode is not None
    assert verb in procs[0].args


@pytest.mark.parametrize("name", ["hippo.cmd.", "hippo.cmd. .", "HIPPO.CMD", "hippo.bat", "hippo.com",
                                  "hippo.cmd::$DATA", "hippo.cmd:x.exe", "hippo.cmd:.exe", "hippo",
                                  "hippo.js.", "HIPPO.JS. .", "HIPPO.EXE."])
def test_windows_refuses_disallowed_launchers(name, tmp_path, monkeypatch, started):
    monkeypatch.setenv("HIPPO_BIN", str(tmp_path / name))
    monkeypatch.setattr(sys, "platform", "win32")
    with pytest.raises(ValueError):
        hippo.launcher()
    assert hippo.run_hippo("recall", [], text="x") is None
    assert not hippo.HippoProvider().is_available()
    assert started == []


@pytest.mark.parametrize(("name", "under_node"), [("hippo.js", True), ("HIPPO.JS", True),
                                                  ("hippo.exe", False), ("HIPPO.EXE", False)])
def test_windows_allows_a_js_or_an_exe(name, under_node, tmp_path, monkeypatch):
    path = str((tmp_path / name).resolve())
    monkeypatch.setenv("HIPPO_BIN", path)
    monkeypatch.setattr(sys, "platform", "win32")
    assert hippo.launcher() == (["node", path] if under_node else [path])


@pytest.mark.parametrize(("found", "available"), [("C:\\bin\\hippo.cmd.", False), ("C:\\bin\\HIPPO.CMD", False),
                                                  ("C:\\bin\\hippo.exe", True)])
def test_windows_judges_a_path_hit_like_a_set_bin(found, available, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(hippo.shutil, "which", lambda name: found)
    assert hippo.HippoProvider().is_available() is available


def test_the_spy_records_the_plugin_launches_and_no_other_process(fake, started):
    with subprocess.Popen([sys.executable, "-c", "pass"], stdout=subprocess.PIPE, stderr=subprocess.PIPE) as other:
        other.communicate()
    assert started == []
    assert hippo.run_hippo("recall", [], text="x") is not None
    assert len(started) == 1 and "--global" in started[0].argv


def test_a_js_bin_runs_under_node(tmp_path, monkeypatch):
    script = tmp_path / "hippo.js"
    script.write_text("", encoding="utf-8")
    monkeypatch.setenv("HIPPO_BIN", str(script))
    assert hippo.launcher() == ["node", str(script.resolve())]
    hippo.LAUNCHER_FILE.write_text(json.dumps({"node": sys.executable, "script": str(script)}), encoding="utf-8")
    assert hippo.launcher() == [sys.executable, str(script.resolve())]
    exe = tmp_path / "hippo.exe"
    exe.write_text("", encoding="utf-8")
    monkeypatch.setenv("HIPPO_BIN", str(exe))
    assert hippo.launcher() == [str(exe.resolve())]


def test_relative_hippo_bin_resolves_before_running_from_home(tmp_path, monkeypatch):
    sub = tmp_path / "rel"
    sub.mkdir()
    script = sub / "hippo.js"
    script.write_text("console.log(JSON.stringify({results: []}));\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HIPPO_BIN", "./rel/hippo.js")
    assert hippo.HippoProvider().is_available()
    assert hippo.launcher()[-1] == str(script.resolve())
    res = hippo.run_hippo("recall", [], text="hi")
    assert res is not None and res.code == 0


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


def test_relative_hippo_home_resolves_against_cwd_before_spawning(fake, tmp_path, monkeypatch, started):
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)
    monkeypatch.setenv("HIPPO_HOME", "./rel-store")
    res = hippo.run_hippo("recall", [], text="hi")
    assert res is not None and res.code == 0
    [call] = fake.calls("recall")
    assert same_path(call["hippoHome"], work / "rel-store")
    assert started[0].kwargs["env"] is not None


def test_absolute_hippo_home_keeps_default_child_env(fake, env, started):
    res = hippo.run_hippo("recall", [], text="hi")
    assert res is not None and res.code == 0
    assert started[0].kwargs["env"] is None


def test_tilde_hippo_home_expands_before_spawning_child(fake, env, monkeypatch, started):
    monkeypatch.setenv("HIPPO_HOME", "~/some-store")
    res = hippo.run_hippo("recall", [], text="hi")
    assert res is not None and res.code == 0
    [call] = fake.calls("recall")
    assert call["hippoHome"] != "~/some-store"
    assert same_path(call["hippoHome"], env.home / "some-store")
    assert started[0].kwargs["env"] is not None
    assert same_path(started[0].kwargs["env"]["HIPPO_HOME"], env.home / "some-store")


def test_windows_refuses_symlink_resolving_to_disallowed_launcher(tmp_path, monkeypatch, started):
    target = tmp_path / "hippo.cmd"
    target.write_text("@echo off\n", encoding="utf-8")
    link = tmp_path / "hippo.exe"
    try:
        link.symlink_to(target)
    except OSError:
        link.write_text("", encoding="utf-8")
        real_resolve = Path.resolve

        def fake_resolve(self, *args, **kwargs):
            return target if self == link else real_resolve(self, *args, **kwargs)

        monkeypatch.setattr(Path, "resolve", fake_resolve)
    monkeypatch.setenv("HIPPO_BIN", str(link))
    monkeypatch.setattr(sys, "platform", "win32")
    with pytest.raises(ValueError):
        hippo.launcher()
    assert hippo.run_hippo("recall", [], text="x") is None
    assert not hippo.HippoProvider().is_available()
    assert started == []
