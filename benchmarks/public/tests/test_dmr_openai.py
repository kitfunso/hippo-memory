"""mem0/dmr_openai.py: the role line is the one change to the registered prompt, and the harness check reads the band."""
from __future__ import annotations

import json

import pytest

import dmr_openai as do
from qa.loaders import dmr


def test_the_role_line_is_the_only_change_to_the_registered_prompt():
    system, user = dmr.answer_prompt({"question": "What was the artist?"}, [{"memory": "Speaker 1: I like Taylor Swift"}])
    out = do.with_role(system)
    assert out.replace(do.ROLE, "", 1) == system and out.index(do.ROLE) == len(do.FIRST)
    assert user == "What was the artist?"


def test_a_changed_registered_prompt_stops_the_run():
    with pytest.raises(SystemExit):
        do.with_role("Another first line.\n{memories}")


def test_the_answer_goes_as_system_then_user_with_the_pinned_model(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    llm = do.OpenAIChat(tmp_path / "calls.jsonl", do.ANSWERER, slots=1, spend=tmp_path / "spend", cap=1.0)
    assert json.loads(llm._body("sys", "q")) == {
        "model": "gpt-4o-mini-2024-07-18", "temperature": 0.0,
        "messages": [{"role": "system", "content": "sys"}, {"role": "user", "content": "q"}]}


def test_the_harness_check_passes_only_inside_the_published_band():
    assert do.band_line("full", 95.0)[0].startswith("harness check: full PASS")
    assert do.band_line("full", 83.6)[0].startswith("harness check: full FAIL")
    assert do.band_line("hippo-best", 50.0) == []
