"""mem0/evermembench_openai.py: the paper's answer settings on the wire, and the Table 4 mean weighting each category once."""
from __future__ import annotations

import json

import evermembench_openai as eo


def test_the_answer_goes_as_one_user_message_with_the_pinned_settings(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    llm = eo.OpenAIChat(tmp_path / "calls.jsonl", eo.ANSWERER, slots=1, spend=tmp_path / "spend", cap=1.0)
    assert json.loads(llm._body("", "the prompt")) == {
        "model": "gpt-4.1-mini-2025-04-14", "temperature": 0.0, "max_tokens": 1000,
        "messages": [{"role": "user", "content": "the prompt"}]}


def test_the_category_mean_weights_each_category_once():
    right = {"a1": True, "a2": True, "a3": True, "b1": False}
    cats = {"a1": "A", "a2": "A", "a3": "A", "b1": "B"}
    assert eo.category_mean(right, cats) == 50.0
