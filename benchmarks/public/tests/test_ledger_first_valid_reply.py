"""qa/ledger.py: the first valid reply among an item's first 3 asks, the frozen manifest, the per-item system hash,
tool use as a rejected ask, and resumes that never ask an item past its 3rd ask."""
from __future__ import annotations

import threading
import time

import pytest
from conftest import rec, write_log

from claude_llm import ToolUse
from qa.ledger import ANSWERER, JUDGE, Item, Ledger, require, smoke_excluded


def label(text: str) -> str | None:
    return text if text in ("CORRECT", "WRONG") else None


ITEM = Item("judge j00001", "grade it", "question and answer", ANSWERER, label)


def ask_rec(item: Item, **kw) -> dict:
    return rec(item.tag, item.user, system=item.system, **kw)


class FakeLLM:
    """Stands in for Claude or CodexJudge: hands out the queued replies and counts the asks."""

    def __init__(self, replies: list, cli: str = ANSWERER.cli) -> None:
        self.replies, self.cli, self.asked = list(replies), cli, []

    def ask(self, system: str, user: str, *, effort: str, tag: str) -> dict:
        self.asked.append(tag)
        r = self.replies.pop(0)
        if isinstance(r, ToolUse):
            raise r
        return r


def test_first_valid_reply_within_three_asks(tmp_path):
    log = write_log(tmp_path / "calls.jsonl", [ask_rec(ITEM, text="maybe"), ask_rec(ITEM, text="WRONG"),
                                               ask_rec(ITEM, text="CORRECT")])
    c = Ledger(log).choose(ITEM)
    assert (c.status, c.value, c.asks, c.rejected) == ("valid", "WRONG", 2, ("reply does not parse",))


def test_a_valid_reply_after_the_third_ask_never_counts(tmp_path):
    log = write_log(tmp_path / "calls.jsonl", [ask_rec(ITEM, text="x")] * 3 + [ask_rec(ITEM, text="CORRECT")])
    c = Ledger(log).choose(ITEM)
    assert (c.status, c.asks, c.value) == ("exhausted", 3, None)


def test_errors_timeouts_and_limit_waits_are_not_asks(tmp_path):
    log = write_log(tmp_path / "calls.jsonl", [ask_rec(ITEM, event="error"), ask_rec(ITEM, event="limit-wait"),
                                               ask_rec(ITEM, event="fail"), ask_rec(ITEM, event="error"),
                                               ask_rec(ITEM, text="CORRECT")])
    assert Ledger(log).choose(ITEM).asks == 1


def test_a_reply_that_does_not_parse_as_json_is_an_ask(tmp_path):
    log = write_log(tmp_path / "calls.jsonl", [ask_rec(ITEM, event="json-miss", text="no json")] * 3)
    assert Ledger(log).choose(ITEM).status == "exhausted"


@pytest.mark.parametrize("field,kw", [("models", {"model": "claude-opus-5"}), ("effort", {"effort": "high"}),
                                      ("cli", {"cli": "2.1.400 (Claude Code)"})])
def test_a_record_off_the_frozen_manifest_is_rejected(tmp_path, field, kw):
    log = write_log(tmp_path / "calls.jsonl", [ask_rec(ITEM, text="CORRECT", **kw), ask_rec(ITEM, text="WRONG")])
    c = Ledger(log).choose(ITEM)
    assert (c.status, c.value, c.asks) == ("valid", "WRONG", 2)
    assert c.rejected[0].startswith(field)


def test_a_record_without_a_cli_stamp_is_rejected(tmp_path):
    old = ask_rec(ITEM, text="CORRECT")
    del old["cli"]
    assert Ledger(write_log(tmp_path / "calls.jsonl", [old])).choose(ITEM).rejected[0].startswith("cli None")


def test_the_system_hash_is_checked_per_item(tmp_path):
    """DMR puts each question's memories in its system prompt, so every item carries its own system text."""
    a = Item("answer hippo365 dmr-001", "memories of dmr-001", "q1", ANSWERER)
    b = Item("answer hippo365 dmr-002", "memories of dmr-002", "q2", ANSWERER)
    log = write_log(tmp_path / "calls.jsonl", [rec(a.tag, a.user, system=a.system, text="A"),
                                               rec(b.tag, b.user, system=a.system, text="B")])
    ledger = Ledger(log)
    assert ledger.choose(a).value == "A"
    c = ledger.choose(b)
    assert (c.status, c.asks) == ("open", 1) and c.rejected[0].startswith("system hash")


def test_a_reply_that_used_a_tool_is_a_rejected_ask(tmp_path):
    item = Item("judge j00002", "grade it", "q", JUDGE, label)
    tool = rec(item.tag, item.user, system=item.system, event="tool-use", text="CORRECT", model=JUDGE.model, cli=JUDGE.cli)
    ok = rec(item.tag, item.user, system=item.system, text="WRONG", model=JUDGE.model, cli=JUDGE.cli)
    assert Ledger(write_log(tmp_path / "a.jsonl", [tool] * 3 + [ok])).choose(item).status == "exhausted"
    c = Ledger(write_log(tmp_path / "b.jsonl", [tool, ok])).choose(item)
    assert (c.status, c.value, c.asks) == ("valid", "WRONG", 2)


def test_resume_reuses_the_valid_reply_in_the_log(tmp_path):
    ledger = Ledger(write_log(tmp_path / "calls.jsonl", [ask_rec(ITEM, text="x"), ask_rec(ITEM, text="CORRECT")]))
    llm = FakeLLM([])
    assert ledger.settle(ITEM, llm).value == "CORRECT" and llm.asked == []


def test_resume_asks_only_what_is_left_of_three(tmp_path):
    ledger = Ledger(write_log(tmp_path / "calls.jsonl", [ask_rec(ITEM, text="x")]))
    llm = FakeLLM([ask_rec(ITEM, text="y"), ask_rec(ITEM, text="z"), ask_rec(ITEM, text="CORRECT")])
    c = ledger.settle(ITEM, llm)
    assert (c.status, c.asks, len(llm.asked)) == ("exhausted", 3, 2)


def test_an_exhausted_item_is_never_asked_again(tmp_path):
    ledger = Ledger(write_log(tmp_path / "calls.jsonl", [ask_rec(ITEM, text="x")] * 3))
    llm = FakeLLM([])
    assert ledger.settle(ITEM, llm).status == "exhausted" and llm.asked == []


def test_a_tool_use_raised_during_settle_counts_as_an_ask(tmp_path):
    ledger = Ledger(tmp_path / "none.jsonl")
    llm = FakeLLM([ToolUse({**ask_rec(ITEM, event="tool-use", text="CORRECT"), "tools": ["2 agent messages"]}),
                   ask_rec(ITEM, text="WRONG")])
    c = ledger.settle(ITEM, llm)
    assert (c.status, c.value, c.asks, len(llm.asked)) == ("valid", "WRONG", 2, 2)


def test_one_prompt_settled_from_two_threads_is_asked_once(tmp_path):
    ledger, lock = Ledger(tmp_path / "none.jsonl"), threading.Lock()

    class Slow(FakeLLM):
        def ask(self, system: str, user: str, *, effort: str, tag: str) -> dict:
            time.sleep(0.05)
            with lock:
                return super().ask(system, user, effort=effort, tag=tag)

    llm = Slow([ask_rec(ITEM, text="CORRECT")] * 2)
    threads = [threading.Thread(target=ledger.settle, args=(ITEM, llm)) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(llm.asked) == 1


def test_a_record_still_being_written_is_no_ask(tmp_path):
    path = write_log(tmp_path / "calls.jsonl", [ask_rec(ITEM, text="x")])
    path.write_bytes(path.read_bytes() + b'{"tag": "judge j00001", "event": "ok", "te')
    assert Ledger(path).choose(ITEM).asks == 1


def test_require_stops_before_asking_on_another_cli():
    require(FakeLLM([], cli=ANSWERER.cli), ANSWERER)
    with pytest.raises(SystemExit, match="frozen manifest"):
        require(FakeLLM([], cli="2.1.400 (Claude Code)"), ANSWERER)


def test_smoke_items_need_an_entry_and_must_be_items(tmp_path, monkeypatch):
    import qa.ledger as ledger
    monkeypatch.setattr(ledger, "SMOKE", tmp_path / "smoke.json")
    (tmp_path / "smoke.json").write_text('{"bench": ["q1"], "empty": []}', encoding="utf-8")
    assert smoke_excluded("bench", ["q0", "q1"]) == {"q1"}
    assert smoke_excluded("empty", ["q0"]) == set()
    with pytest.raises(SystemExit, match="no entry for other"):
        smoke_excluded("other", ["q0"])
    with pytest.raises(SystemExit, match="not its items"):
        smoke_excluded("bench", ["q0"])
