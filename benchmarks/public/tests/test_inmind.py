"""inmind/: InMind's pinned code and data, the middle-injection timeline, its gpt-5-mini settings on the wire, the
judge verdict parse, and the answerer's leakage boundary (notes-2026-11-17-inmind.md)."""
from __future__ import annotations

import hashlib
import json

import pytest
from conftest import PUBLIC

from inmind import inmind_hippo as ih
from inmind import vendor as v
from qa.openai_reasoning import ReasoningChat
from qa.vendor_pin import drift

needs_data = pytest.mark.skipif(not ((v.CLONE / ".git").exists() and (v.DATA / "inmind.jsonl").exists()),
                                reason="InMind's clone or dataset copy is not on this box")


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def test_the_published_setup_is_pinned():
    assert (v.COMMIT, v.SNAPSHOT, v.TOPK, v.METRICS) == (
        "5a2ab2686d3d5b832575f0288d41ecc93eab358b", "gpt-5-mini-2025-08-07", 10, ("naive", "target-recall", "application"))
    assert (v.ANSWERER.max_completion_tokens, v.JUDGE.max_completion_tokens) == (16_384, 4_096)
    assert not v.ANSWERER.json_object and not v.JUDGE.json_object


def test_answers_and_judges_send_what_table_6_sends(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    for s, cap in ((v.ANSWERER, 16_384), (v.JUDGE, 4_096)):
        body = json.loads(ReasoningChat(tmp_path / "c.jsonl", s, spend=tmp_path / "spend")._body("s", "q"))
        assert body == {"model": "gpt-5-mini-2025-08-07", "max_completion_tokens": cap,
                        "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "q"}]}


@needs_data
def test_the_clone_and_data_are_the_pinned_release_and_the_prompts_are_its_text():
    assert drift(v.CLONE, v.COMMIT, v.BLOBS) == []
    assert sha(v.answer_system("CTX")) == "a15755700da5561cb0fcd77d4635b353a07feef9d9c6720e093b8e9bac92faef"
    assert [sha(v.judge_system(m)) for m in v.METRICS] == [
        "a8e828434643ba8447b2762175b340c3d576d16c249bee9e1ddea2c090744d25",
        "7873cd656e6ba23ed1b71a3604008e2bad51258b1248210851fd9d4457736d8f",
        "8f651483bb494deba5d34592ec87db5db27f10bf98d0cd6f75486fc60a24e2e3"]
    assert len(v.tasks()) == 125


@needs_data
def test_the_target_pair_ends_session_9_with_41_user_turns_before_it_and_38_sessions_after():
    task = next(t for t in v.tasks() if t["task_id"] == 155)
    tl = v.timeline(task)
    at = [i for i, x in enumerate(tl) if x["content"] == task["user_message"]]
    assert len(tl) == 488 and at == [84] and tl[85]["content"] == task["assistant_message"]
    assert sum(x["role"] == "user" for x in tl[:84]) == 41 and len(tl) - 86 == 402
    assert all(x["timestamp"] is None for x in tl)  # the target has no time, so nothing else gets one


@needs_data
def test_the_answerer_never_sees_judge_only_fields(tmp_path):
    task = v.tasks()[0]
    out, qid = tmp_path / "hippo-emb", "task-0-query"
    p = ih.pred_path(out, "hippo-emb", qid)
    p.parent.mkdir(parents=True)
    p.write_text(json.dumps({"results": [{"memory": "user: " + task["user_message"]}]}), encoding="utf-8")
    (out / "predicted" / "manifest.json").write_text(json.dumps({"hippo-emb": {qid: ih.sha_bytes(p.read_bytes())}}))
    item = ih.answer_items(out, "hippo-emb", [{"qid": qid, "question": task["query"]}])[qid]
    assert item.user == task["query"] and f"- user: {task['user_message']}" in item.system
    for field in ("explanation", "relation", "entity_1", "entity_2"):
        assert task[field] not in item.system + item.user


@needs_data
def test_the_smoke_tasks_are_registered_and_only_the_first_is_asked():
    ih.Run.smoke = True
    try:
        qs = ih.questions()
        assert [q["qid"] for q in ih.asked(qs)] == ["task-0-naive", "task-0-query"] and len(qs) == 10
        table = json.loads((PUBLIC / "smoke_excluded.json").read_text(encoding="utf-8"))
        assert table["inmind"] == [ih.unit(t) for t in ih.picked()]
    finally:
        ih.Run.smoke = False


@pytest.mark.parametrize("text,want", [('{"score": 1, "reason": "r"}', 1), ('```json\n{"score": 0}\n```', 0),
                                       ('{"score": true}', None), ('{"score": "1"}', None), ('{"score": 2}', None),
                                       ("score: 1", None), ("[1]", None)])
def test_a_verdict_is_a_json_binary_score(text, want):
    assert v.verdict(text) == want
