"""fill_app_args: a transcript app call takes the server's logged arguments, and only keys the agent left out change."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dolphinbench"))  # dolphin_hippo imports its siblings

from dolphin_hippo import fill_app_args  # noqa: E402

P = "mcp__dolphinbench_apps__"


def transcript(*calls: tuple[str, dict]) -> list[dict]:
    return [{"role": "assistant", "content": "", "tool_calls": [
        {"id": f"c{i}", "name": name, "arguments": dict(args)} for i, (name, args) in enumerate(calls)]}]


def args_of(messages: list[dict]) -> list[dict]:
    return [c["arguments"] for c in messages[0]["tool_calls"]]


def test_a_left_out_default_is_filled_from_the_log() -> None:
    m = transcript((P + "send_email", {"to": "a@x.io", "body": "hi"}), ("mcp__memory__search_memories", {"query": "q"}))
    fill_app_args(m, [{"tool": "send_email", "args": {"to": "a@x.io", "body": "hi", "cc": None}}])
    assert args_of(m) == [{"to": "a@x.io", "body": "hi", "cc": None}, {"query": "q"}]


def test_exact_matches_pair_first_so_a_sent_cc_is_never_given_to_the_call_without_it() -> None:
    m = transcript((P + "send_email", {"to": "a@x.io"}), (P + "send_email", {"to": "a@x.io", "cc": ["b@x.io"]}))
    fill_app_args(m, [{"tool": "send_email", "args": {"to": "a@x.io", "cc": ["b@x.io"]}},
                      {"tool": "send_email", "args": {"to": "a@x.io", "cc": None}}])
    assert args_of(m) == [{"to": "a@x.io", "cc": None}, {"to": "a@x.io", "cc": ["b@x.io"]}]


def test_a_sent_value_that_differs_from_the_log_is_left_alone() -> None:
    m = transcript((P + "list_open_prs", {"status": "closed"}))
    fill_app_args(m, [{"tool": "list_open_prs", "args": {"status": "open", "author": None}}])
    assert args_of(m) == [{"status": "closed"}]
