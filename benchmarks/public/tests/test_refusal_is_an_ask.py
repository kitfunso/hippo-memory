"""A usage-policy refusal (dated notes 11) is an ask that is never valid: one call each, and 3 exhaust the item."""
from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest
from conftest import rec, write_log

import claude_llm
from claude_llm import Claude, Refusal
from qa.ledger import ANSWERER, Item, Ledger

SAFEGUARD = ("API Error: Sonnet 5's safeguards flagged this message. Our intentionally broad safeguards allow us to "
             "deliver more capabilities faster.\n\nDetails: `[cyber]`")
AUP = "API Error: Sonnet 5 can't help with this. Start a new session to continue.\n\nLearn more: https://www.anthropic.com/legal/aup"
OK = {"result": "yes", "modelUsage": {"claude-sonnet-5": {}}}


def client(tmp_path: Path) -> Claude:
    c = object.__new__(Claude)  # no CLI on the test box: set only what ask() and _log read
    c.sysdir, c.log_path, c.lock, c.cli = tmp_path, tmp_path / "calls.jsonl", threading.Lock(), ANSWERER.cli
    return c


def events(c: Claude) -> list[str]:
    return [json.loads(line)["event"] for line in c.log_path.read_text(encoding="utf-8").splitlines()]


@pytest.mark.parametrize("text", [SAFEGUARD, AUP])
def test_a_refusal_is_one_call_logged_as_a_refusal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, text: str) -> None:
    c, calls = client(tmp_path), []
    monkeypatch.setattr(c, "_run", lambda *a, **k: calls.append(1) or ({"is_error": True, "result": text}, ""))
    monkeypatch.setattr(claude_llm.time, "sleep", lambda s: pytest.fail("a refusal is never retried inside ask"))
    with pytest.raises(Refusal):
        c.ask("sys", "user", effort="medium", tag="answer hippo365 q1")
    assert len(calls) == 1 and events(c) == ["refusal"]


def test_an_ordinary_error_is_still_retried_and_is_no_ask(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    c = client(tmp_path)
    replies = iter([({"is_error": True, "result": "API Error: 529 Overloaded"}, ""), (OK, "")])
    monkeypatch.setattr(c, "_run", lambda *a, **k: next(replies))
    monkeypatch.setattr(claude_llm.time, "sleep", lambda s: None)
    item = Item("answer bm25 q1", "sys", "user", ANSWERER)
    assert Ledger(c.log_path).settle(item, c).status == "valid"
    assert events(c) == ["error", "ok"]
    assert Ledger(c.log_path).choose(item).asks == 1


def test_three_refusals_exhaust_the_item_and_a_rerun_calls_nothing(tmp_path: Path,
                                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    c, calls = client(tmp_path), []
    monkeypatch.setattr(c, "_run", lambda *a, **k: calls.append(1) or ({"is_error": True, "result": AUP}, ""))
    item = Item("answer hippo365 q1", "sys", "user", ANSWERER)
    first = Ledger(c.log_path).settle(item, c)
    assert first.status == "exhausted" and len(calls) == 3
    assert all(why.startswith("event 'refusal'") for why in first.rejected)
    assert Ledger(c.log_path).settle(item, c).status == "exhausted" and len(calls) == 3


def test_refusals_logged_as_errors_before_the_note_count_as_asks(tmp_path: Path) -> None:
    refused = [{**rec("answer bm25 q1", "u", event="error"), "detail": f"None {SAFEGUARD} "} for _ in range(3)]
    busy = [{**rec("answer bm25 q2", "u", event="error"), "detail": "529 API Error: 529 Overloaded "} for _ in range(5)]
    led = Ledger(write_log(tmp_path / "calls.jsonl", refused + busy))
    assert led.choose(Item("answer bm25 q1", "", "u", ANSWERER)).status == "exhausted"
    assert led.choose(Item("answer bm25 q2", "", "u", ANSWERER)).status == "open"
