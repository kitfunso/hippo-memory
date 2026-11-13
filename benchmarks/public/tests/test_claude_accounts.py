"""The token pool (dated notes 10): a usage limit rests one account and the call moves to the next, never made up."""
from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

import claude_llm
from claude_llm import Accounts, Claude

TOK = {"A": "a" * 108, "B": "b" * 108, "SHORT": "x"}


def client(tmp_path: Path, names: list[str]) -> Claude:
    c = object.__new__(Claude)  # no CLI on the test box: set only what ask() and _log read
    c.sysdir, c.log_path, c.lock, c.cli = tmp_path, tmp_path / "calls.jsonl", threading.Lock(), "test"
    c.accounts = Accounts(names, TOK)
    return c


def events(c: Claude) -> list[dict]:
    return [json.loads(l) for l in c.log_path.read_text(encoding="utf-8").splitlines()]


def test_pick_skips_unset_tokens_and_resting_accounts() -> None:
    acc = Accounts(["SHORT", "A", "B", "MISSING"], TOK)
    assert acc.names == ["A", "B"]
    assert acc.pick(0.0) == "A"
    acc.rest("A", 0.0)
    assert acc.pick(1.0) == "B"
    acc.rest("B", 10.0)
    assert acc.pick(11.0) is None
    assert acc.wake(11.0) == pytest.approx(Accounts.REST_S - 11.0)
    assert acc.pick(Accounts.REST_S + 1.0) == "A"


def test_a_usage_limit_moves_the_call_to_the_next_account(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    c = client(tmp_path, ["A", "B"])
    seen = []

    def run(sys_file, user, effort, deadline, account=None):
        seen.append(account)
        if account == "A":
            return {"is_error": True, "api_error_status": 429, "result": "You've hit your weekly limit"}, ""
        return {"result": "ok", "modelUsage": {"claude-sonnet-5": {}}}, ""

    monkeypatch.setattr(c, "_run", run)
    monkeypatch.setattr(claude_llm.time, "sleep", lambda s: pytest.fail("no wait while another account is free"))
    rec = c.ask("sys", "user", effort="medium", tag="t1")
    assert seen == ["A", "B"]
    assert rec["account"] == "B" and rec["text"] == "ok"
    log = events(c)
    assert [r["event"] for r in log] == ["limit-wait", "ok"]
    assert log[0]["account"] == "A" and log[0]["delay_s"] == 0
    assert c.ask("sys", "user2", effort="medium", tag="t2")["account"] == "B"  # A rests, so it is not tried again


def test_every_account_resting_waits_then_tries_again(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    c = client(tmp_path, ["A"])
    clock = [1000.0]
    monkeypatch.setattr(claude_llm.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(claude_llm.time, "sleep", lambda s: clock.__setitem__(0, clock[0] + s))
    calls = iter([({"is_error": True, "result": "You've hit your limit · resets 4am"}, ""), ({"result": "ok"}, "")])
    monkeypatch.setattr(c, "_run", lambda *a, **k: next(calls))
    rec = c.ask("sys", "user", effort="medium", tag="t")
    assert rec["text"] == "ok" and rec["account"] == "A"
    waits = [r for r in events(c) if r["event"] == "limit-wait"]
    assert waits[0]["delay_s"] == 0 and sum(r["delay_s"] for r in waits) >= Accounts.REST_S
    assert all(r["delay_s"] <= 300 for r in waits)
