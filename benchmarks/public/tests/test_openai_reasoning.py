"""qa/openai_reasoning.py: Mem0's gpt-5 request body, and empty content kept as the answer "" as Mem0's client keeps it."""
from __future__ import annotations

import json

import pytest
from test_openai_llm import http_error, wire  # noqa: F401  (wire is the fixture)

from qa import openai_reasoning as orz
from qa.ledger import Item, Ledger, Manifest

GPT5 = "gpt-5-2025-08-07"


def reply(content: str | None) -> dict:
    return {"model": GPT5, "choices": [{"message": {"content": content}, "finish_reason": "length"}],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 4096}}


def client(tmp_path, s: orz.ReasoningSettings) -> orz.ReasoningChat:
    return orz.ReasoningChat(tmp_path / "calls.jsonl", s, slots=1, spend=tmp_path / "spend", cap=10.0)


def test_no_temperature_and_max_completion_tokens_and_json_only_for_the_judge(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    answer = client(tmp_path, orz.ReasoningSettings(GPT5))
    judge = client(tmp_path, orz.ReasoningSettings(GPT5, json_object=True))
    assert json.loads(answer._body("", "q")) == {
        "model": GPT5, "max_completion_tokens": 4096, "messages": [{"role": "user", "content": "q"}]}
    assert json.loads(judge._body("s", "q")) == {
        "model": GPT5, "max_completion_tokens": 4096, "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "q"}]}


def test_empty_content_is_one_ask_whose_answer_is_empty(tmp_path, wire):  # noqa: F811
    sent, queue = wire
    s = orz.ReasoningSettings(GPT5)
    llm = client(tmp_path, s)
    queue.append(reply(""))
    c = Ledger(llm.log_path).settle(Item("answer a q1", "", "q", Manifest(GPT5, orz.EFFORT, s.cli), orz.reply_text), llm)
    assert (c.status, c.asks, c.value, len(sent)) == ("valid", 1, "", 1)
    spend = json.loads(llm.spend_path.read_text().splitlines()[0])["usd"]
    assert spend == pytest.approx((1000 * 1.25 + 4096 * 10.00) / 1e6)


def test_a_prompt_over_the_input_limit_is_one_free_ask_whose_answer_is_empty(tmp_path, wire):  # noqa: F811
    sent, queue = wire
    s = orz.ReasoningSettings(GPT5)
    llm = client(tmp_path, s)
    queue.append(http_error(400, '{"error": {"message": "Input tokens exceed the configured limit of 272000 tokens.", '
                                 '"code": "context_length_exceeded"}}'))
    c = Ledger(llm.log_path).settle(Item("answer a q1", "", "q", Manifest(GPT5, orz.EFFORT, s.cli), orz.reply_text), llm)
    assert (c.status, c.asks, c.value, len(sent), c.record["text"]) == ("valid", 1, "", 1, orz.TOO_LONG)
    assert json.loads(llm.spend_path.read_text().splitlines()[0])["usd"] == 0


def test_none_content_is_asked_again(tmp_path, wire):  # noqa: F811
    sent, queue = wire
    s = orz.ReasoningSettings(GPT5)
    llm = client(tmp_path, s)
    queue += [reply(None), reply("ANSWER: Paris")]
    c = Ledger(llm.log_path).settle(Item("answer a q1", "", "q", Manifest(GPT5, orz.EFFORT, s.cli), orz.reply_text), llm)
    assert (c.status, c.value, len(sent)) == ("valid", "ANSWER: Paris", 2)
