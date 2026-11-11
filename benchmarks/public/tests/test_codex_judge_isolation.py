"""qa/codex_judge.py: the CLI stamp on every record, an empty working folder outside any checkout, tool use read from
the event stream and stderr, and a preamble that a caller may replace at run time (runner/answer_judge.py does)."""
from __future__ import annotations

import base64
import datetime as dt
import json
import subprocess
import threading
from pathlib import Path

import pytest
from conftest import rec

import codex_judge
from claude_llm import Claude, ToolUse
from qa.ledger import JUDGE, Item, Ledger, decide

NOTICE_LINE = ('{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Code Mode is unavailable '
               'because code-mode host is disabled. Code mode will fail closed."}}')
# `codex exec --json` from codex-cli 0.164.0 on 11 Nov 2026: a plain grading reply, then a prompt that made the model
# call a tool. The tool call shows no item, only a second agent message and the router's stderr line.
PLAIN = "\n".join([
    '{"type":"thread.started","thread_id":"t1"}', NOTICE_LINE, '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\\"label\\":\\"CORRECT\\"}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":7787,"output_tokens":10}}'])
FORCED = "\n".join([
    '{"type":"thread.started","thread_id":"t2"}', NOTICE_LINE, '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"I will run that command."}}',
    '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"hello"}}',
    '{"type":"turn.completed","usage":{"input_tokens":15569,"output_tokens":256}}'])
ROUTER = "2026-11-11T15:48:14.983773Z ERROR codex_core::tools::router: error=code-mode host is disabled\n"


def test_a_plain_reply_shows_no_tool():
    res, _ = codex_judge.read_run(0, PLAIN, "")
    assert res["result"] == '{"label":"CORRECT"}' and "tools" not in res and not res.get("is_error")


def test_a_code_mode_tool_call_is_seen_in_stderr_and_a_second_message():
    res, _ = codex_judge.read_run(0, FORCED, ROUTER)
    assert not res.get("is_error") and res["result"] == "hello"
    assert any("codex_core::tools::router" in t for t in res["tools"]) and "2 agent messages" in res["tools"]


def test_any_tool_item_is_tool_use():
    out = "\n".join([NOTICE_LINE, '{"type":"item.started","item":{"id":"i1","type":"command_execution"}}',
                     '{"type":"item.completed","item":{"id":"i1","type":"command_execution"}}',
                     '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"{}"}}'])
    res, _ = codex_judge.read_run(0, out, "")
    assert res["tools"] == ["item.started command_execution", "item.completed command_execution"]


def test_ask_logs_a_tool_use_reply_and_raises(tmp_path):
    claude = object.__new__(Claude)
    claude.cwd, claude.sysdir, claude.log_path = tmp_path, tmp_path, tmp_path / "calls.jsonl"
    claude.lock, claude.slots, claude.cli = threading.Lock(), threading.BoundedSemaphore(1), JUDGE.cli
    claude._run = lambda *a: ({"result": "hello", "tools": ["2 agent messages"], "modelUsage": {JUDGE.model: {}}}, "")
    with pytest.raises(ToolUse) as e:
        claude.ask("grade it", "q", effort="medium", tag="judge j1")
    logged = json.loads((tmp_path / "calls.jsonl").read_text(encoding="utf-8"))
    assert logged["event"] == "tool-use" and logged["text"] == "hello" and e.value.rec["tools"] == ["2 agent messages"]
    item = Item("judge j1", "grade it", "q", JUDGE, lambda t: t)
    assert Ledger(tmp_path / "calls.jsonl").choose(item).rejected[0].startswith("event 'tool-use'")


def _login(home: Path) -> None:
    exp = int((dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=5)).timestamp())
    claims = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
    home.mkdir(parents=True, exist_ok=True)
    (home / "auth.json").write_text(json.dumps({"last_refresh": "2026-11-11T00:00:00+00:00",
                                                "tokens": {"access_token": f"h.{claims}.s"}}), encoding="utf-8")


@pytest.fixture
def fake_codex(tmp_path, monkeypatch):
    """A CodexJudge whose codex process is faked: `--version` prints codex-cli 0.164.0 and exec prints PLAIN."""
    sent: list[bytes] = []

    def run(cmd, **kw):
        if "--version" in cmd:
            return subprocess.CompletedProcess(cmd, 0, b"codex-cli 0.164.0\n", b"")
        sent.append(kw["input"])
        return subprocess.CompletedProcess(cmd, 0, PLAIN.encode(), b"")

    (tmp_path / "codex.js").write_text("", encoding="utf-8")
    monkeypatch.setattr(codex_judge, "CODEX_JS", tmp_path / "codex.js")
    monkeypatch.setattr(codex_judge.shutil, "which", lambda name: "node")
    monkeypatch.setattr(codex_judge.subprocess, "run", run)
    _login(tmp_path / "main")
    make = lambda **kw: codex_judge.CodexJudge(tmp_path / "out" / "calls-judge.jsonl", 1, home=tmp_path / "pool",  # noqa: E731
                                               main_home=tmp_path / "main", **kw)
    return make, sent


def test_the_judge_stamps_its_codex_version_on_every_record(fake_codex, tmp_path):
    make, _ = fake_codex
    judge = make()
    assert judge.cli == JUDGE.cli
    r = judge.ask("grade it", "q", tag="judge j1")
    item = Item("judge j1", "grade it", "q", JUDGE, lambda t: t)
    assert r["cli"] == JUDGE.cli and decide([r], item).status == "valid"


def test_a_caller_can_replace_the_preamble_at_run_time(fake_codex, monkeypatch):
    make, sent = fake_codex
    monkeypatch.setattr(codex_judge, "PREAMBLE", "You are a grading function. Reply in the asked format.\n\n")
    make().ask("grade it", "q", tag="judge j1")
    assert sent[-1].decode().startswith("You are a grading function. Reply in the asked format.\n\ngrade it")


def test_the_working_folder_must_be_empty_and_outside_any_checkout(fake_codex, tmp_path):
    make, _ = fake_codex
    (tmp_path / "repo" / ".git").mkdir(parents=True)
    with pytest.raises(SystemExit, match="outside any git checkout"):
        make(work=tmp_path / "repo" / "judge")
    (tmp_path / "used" / "cwd").mkdir(parents=True)
    (tmp_path / "used" / "cwd" / "answer.txt").write_text("CORRECT", encoding="utf-8")
    with pytest.raises(SystemExit, match="must be empty"):
        make(work=tmp_path / "used")


def test_the_flags_keep_the_read_only_sandbox(fake_codex):
    make, _ = fake_codex
    cmd = make().cmd
    assert cmd[cmd.index("-s") + 1] == "read-only" and "--json" in cmd


def test_a_tool_use_record_matches_the_ledger_shape():
    r = rec("judge j1", "q", system="grade it", event="tool-use", model=JUDGE.model, cli=JUDGE.cli)
    assert decide([r] * 3, Item("judge j1", "grade it", "q", JUDGE, lambda t: t)).status == "exhausted"
