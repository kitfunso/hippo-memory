"""locomo_plus/: the pinned framework, its gpt-4o settings on the wire, the input and judge prompts it builds, and
Table 1's cells (notes-2026-11-17-locomo-plus.md)."""
from __future__ import annotations

import hashlib
import json
import sys

import pytest
from conftest import PUBLIC

sys.path.insert(0, str(PUBLIC / "locomo_plus"))
import locomo_plus_hippo as lp  # noqa: E402
from qa import openai_llm as ol  # noqa: E402
from qa.vendor_pin import drift  # noqa: E402

needs_clone = pytest.mark.skipif(not (lp.CLONE / ".git").exists(), reason="Locomo-Plus's clone is not on this box")


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def test_the_published_settings_go_on_the_wire(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    assert (lp.COMMIT, lp.TOPK, lp.FOUR_O) == ("059f4e3d38f7f1f96765e8e2cb7de3097551bffb", 5, "gpt-4o-2024-08-06")
    body = json.loads(ol.OpenAIChat(tmp_path / "a.jsonl", lp.ANSWERER, spend=tmp_path / "s")._body("", "p"))
    assert body == {"model": "gpt-4o-2024-08-06", "temperature": 0.3, "max_tokens": 1024,
                    "messages": [{"role": "user", "content": "p"}]}
    body = json.loads(ol.OpenAIChat(tmp_path / "j.jsonl", lp.JUDGE, spend=tmp_path / "s")._body("", "p"))
    assert body == {"model": "gpt-4o-2024-08-06", "temperature": 0.0, "max_tokens": 512,
                    "messages": [{"role": "user", "content": "p"}]}


@needs_clone
def test_the_clone_is_the_pinned_framework_with_its_2387_samples():
    assert drift(lp.CLONE, lp.COMMIT, lp.BLOBS) == []
    s = lp.samples()
    assert len(s) == 2387 and sum(x["category"] == "Cognitive" for x in s) == 401
    assert len(dict(lp.conversations())) == 411 and [s[i]["qid"] for i in lp.SMOKE] == [
        "lp-0000", "lp-0496", "lp-0992", "lp-1488", "lp-1986"]


@needs_clone
def test_the_inputs_are_the_frameworks_text_with_hits_in_place_of_the_dialogue():
    s = lp.samples()
    loc, cog = s[0], s[1986]
    hit = [{"memory": "user: " + loc["turns"][1]["content"], "created_at": "2023-05-08T13:56:00.000Z"},
           {"memory": "user: " + loc["turns"][0]["content"], "created_at": "2023-05-08T13:56:00.000Z"}]
    build = lp.vendor()["task_eval.utils"]._build_model_input
    assert lp.body(loc, hit) == (f"DATE: 1:56 pm on 8 May, 2023\nCONVERSATION:\n{loc['turns'][0]['content']}\n"
                                 f"{loc['turns'][1]['content']}\n\nQuestion: {loc['query']}")
    assert sha(build(lp.body(loc, hit), loc["category"])) == \
        "9b58faf959a2d94564986b5848582fb519c2ffe2156ebbf54751375de3552873"
    assert lp.body(cog, []) == cog["trigger_line"] and cog["input_prompt"].endswith(cog["trigger_line"])
    assert sha(build(lp.body(cog, []), "Cognitive")) == "681622395994eb6a2227d6910c31df3da3e13b0598770b76048ca874c2be446e"


@needs_clone
def test_the_judge_prompt_carries_the_conversation_prefix_as_call_model_sends_it():
    q = {"qid": "lp-0000", "i": 0}
    item = lp.judge_item("hippo-emb", q, "7 May 2023")
    assert item.user.startswith("Below is a conversation between two people: A and B.")
    assert "You are a Temporal Logic Judge." in item.user and "Model Prediction:\n7 May 2023" in item.user
    assert sha(item.user) == "a88f3ab02aa047154a4b9f4b8e1fd1c95f7694c85bd309c3394c5a8cd37e581a"


@needs_clone
def test_table_one_cells_average_items_and_the_gap_is_locomo_minus_plus():
    m = lp.vendor()["task_eval.llm_as_judge"]
    recs = [{"category": "single-hop", "judge_score": 1.0}, {"category": "temporal", "judge_score": 0.5},
            {"category": "temporal", "judge_score": 0.0}, {"category": "Cognitive", "judge_score": 1.0},
            {"category": "Cognitive", "judge_score": 0.0}]
    assert lp.table_lines(m, recs, "x") == ["x: single-hop 100.00  multi-hop 0.00  temporal 25.00  common-sense 0.00  "
                                            "adversarial 0.00  LoCoMo 50.00  LoCoMo-Plus 50.00  gap 0.00  n=5"]
    assert [m.label_to_score(m._parse_judge_response(r)[0]) for r in (
        '{"label": "correct", "reason": "x"}', '{"label": "partial", "reason": "x"}', "It is wrong.")] == [1.0, 0.5, 0.0]
