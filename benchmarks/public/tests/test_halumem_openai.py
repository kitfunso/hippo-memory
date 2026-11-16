"""mem0/halumem_openai.py: the authors' GPT-4o settings on the wire, and the ratios over every item."""
from __future__ import annotations

import json

import halumem_openai as ho


def test_answer_and_judge_go_as_one_user_message_with_the_authors_settings(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    llm = ho.OpenAIChat(tmp_path / "calls.jsonl", ho.GPT4O, slots=1, spend=tmp_path / "spend", cap=1.0)
    assert json.loads(llm._body("", "the prompt")) == {
        "model": "gpt-4o-2024-08-06", "temperature": 0.0, "max_tokens": 16384,
        "messages": [{"role": "user", "content": "the prompt"}]}


def test_the_ratios_count_an_exhausted_item_in_the_total():
    labels = {"a": "Correct", "b": "Hallucination", "c": "Omission", "d": "Exhausted"}
    assert ho.ratios(labels, list(labels)) == {"Correct": 25.0, "Hallucination": 25.0, "Omission": 25.0}


def test_the_loader_reads_the_variant_it_is_given():
    assert ho.loader("long").DATA.name == "HaluMem-Long.jsonl"
