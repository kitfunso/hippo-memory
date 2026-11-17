"""mem0/prefeval_memos.py: MemOS's PrefEval text verbatim, its answer and check requests, and its error types."""
from __future__ import annotations

import hashlib
import json

import prefeval_memos as pf
import pytest
from qa import memos_pref_prompts as mp

Q = {"qid": "pref-0007", "question": "Any course ideas?", "preference": "I like classrooms."}


@pytest.mark.parametrize("name,want", [
    ("PREFEVAL_ANSWER_PROMPT", "b5bf7e58477fe9f57ccec4e629fb9173466474fdcfd7a77a7325ac3365055067"),
    ("CHECK_VIOLATE", "d2e6299d18acdbcf462ded1b7cc92f2ffb24a31481909358a6c36f99f9cc90c8"),
    ("CHECK_ACKNOWLEDGE", "39fd1ce91ce6b6a288ea8ed417f9758ad2562e6c9d46ed926654b893f891272e"),
    ("CHECK_HALLUCINATE", "ad9f6d25ac5babb25a09254936c1b8466503e51420182b75741da539c64bf3b1"),
    ("CHECK_HELPFUL", "f9d17a900060025ebf77bb95877c807e2a050c1343889ea7e730a752aa37833a")])
def test_the_prompts_are_memos_text(name, want):
    """sha256 at MemTensor/MemOS 3a16e5fe (vendor_memos_pref.py, 17 Nov), where each f-string filled as MemOS fills it."""
    assert hashlib.sha256(getattr(mp, name).encode()).hexdigest() == want


def test_irre_10_is_ten_turns_and_follows_each_rows_conversation(tmp_path, monkeypatch):
    assert hashlib.sha256(repr(mp.irre_10).encode()).hexdigest() == \
        "ba3cc123c1e7da09dd04e995c7d38aaf96dc546fc5b66a2f066fe933b3158556"
    rows = tmp_path / "rows.jsonl"
    conv = [{"role": "user", "content": "u0"}, {"role": "assistant", "content": "a0"}]
    rows.write_text(json.dumps({"question": "q", "preference": "p", "topic": "t", "conversation": conv}) + "\n")
    monkeypatch.setattr(pf, "ROWS", rows)
    [(user, turns)] = list(pf.conversations())
    assert user == "pref-0000" and [t["content"] for t in turns] == ["u0", "a0", *(m["content"] for m in mp.irre_10)]
    assert len(turns) == 22 and {t["timestamp"] for t in turns} == {None}


def test_the_answer_is_memos_system_prompt_over_ranked_memories_and_the_bare_question(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(pf, "memories", lambda out, arm, qid: ["user: b", "assistant: a"])
    item = pf.answer_items(tmp_path, "hippo-emb", [Q])["pref-0007"]
    assert item.system == mp.PREFEVAL_ANSWER_PROMPT.format(context="- user: b\n- assistant: a\n") and item.user == Q["question"]
    llm = pf.OpenAIChat(tmp_path / "calls.jsonl", pf.ANSWERER, spend=tmp_path / "spend", cap=1.0)
    assert json.loads(llm._body(item.system, item.user)) == {
        "model": "gpt-4o-mini-2024-07-18", "messages": [{"role": "system", "content": item.system},
                                                        {"role": "user", "content": Q["question"]}]}
    judge = pf.OpenAIChat(tmp_path / "judge.jsonl", pf.CHECKER, spend=tmp_path / "spend", cap=1.0)
    assert json.loads(judge._body("", "check")) == {"model": "gpt-4o-mini-2024-07-18", "temperature": 0.0,
                                                    "messages": [{"role": "user", "content": "check"}], "max_tokens": 500}


def test_acknowledge_comes_first_and_a_blank_restatement_makes_no_hallucinate_call():
    assert list(pf.check_items("hippo-emb", Q, "ans", None)) == ["acknowledge"]
    blank = pf.check_items("hippo-emb", Q, "ans", "<preference>  </preference><answer>No</answer>")
    assert list(blank) == ["acknowledge", "violate", "helpful"]
    said = pf.check_items("hippo-emb", Q, "ans", "<preference>You like classrooms</preference><answer>Yes</answer>")
    assert said["hallucinate"].user == mp.CHECK_HALLUCINATE.format(preference=Q["preference"],
                                                                  restatement="You like classrooms")


class C:
    def __init__(self, text: str) -> None:
        self.status, self.value = "valid", text


def test_violated_and_unhelpful_is_memos_personalized_but_wrong_for_the_authors():
    tag = "<answer>{}</answer>"
    checks = {("q", "acknowledge"): C(tag.format("No")), ("q", "violate"): C(tag.format("Yes")),
              ("q", "helpful"): C(tag.format("No"))}
    ev = pf.evaluation("q", checks)
    assert ev["hallucinate_preference"]["answer"] == "No"
    assert mp.classify_error_type(ev) == "Personalized Response" and not pf.authors_right(ev)
    checks[("q", "violate")] = C(tag.format("No"))
    assert mp.classify_error_type(pf.evaluation("q", checks)) == "Unhelpful Response"
