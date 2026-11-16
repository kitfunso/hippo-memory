"""mem0/evermembench_judge_openai.py: the second judge sees lane E's exact prompts, on gpt-4o, logged apart from codex."""
from __future__ import annotations

import json

import evermembench_judge_openai as ej
from qa.ledger import JUDGE, Item
from qa.loaders import evermembench as ev


def test_only_the_tag_and_manifest_change():
    q = {"qtype": "open", "question": "What launched?", "gold": "The platform"}
    _, system, user, parse = ev.judge(q, "the platform")
    codex = Item("gpt41mini judge hippo-emb F_SH_1", system, user, JUDGE, parse)
    mine = ej.as_gpt4o(codex)
    assert (mine.system, mine.user, mine.parse) == (codex.system, codex.user, codex.parse)
    assert mine.tag == "gpt4o judge hippo-emb F_SH_1" and mine.manifest.model == "gpt-4o-2024-08-06"
    assert mine.key != codex.key


def test_the_verdict_goes_as_system_then_user_on_gpt4o(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    llm = ej.OpenAIChat(tmp_path / "calls.jsonl", ej.JUDGE4O, slots=1, spend=tmp_path / "spend", cap=1.0)
    assert json.loads(llm._body("sys", "u")) == {
        "model": "gpt-4o-2024-08-06", "temperature": 0.0,
        "messages": [{"role": "system", "content": "sys"}, {"role": "user", "content": "u"}]}
