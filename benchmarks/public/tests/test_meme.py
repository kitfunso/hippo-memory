"""meme/: MEME's pinned code and data, its gpt-4.1-mini answer and GPT-4o judge on the wire, the ledger client the
vendor judge calls, and Table 2's scoring (notes-2026-11-17-meme-triggerbench.md)."""
from __future__ import annotations

import hashlib
import json
import sys

import pytest
from conftest import PUBLIC, write_log

sys.path.insert(0, str(PUBLIC / "meme"))
import meme_hippo as mh  # noqa: E402
import meme_vendor as v  # noqa: E402
from qa import openai_llm as ol  # noqa: E402
from qa.ledger import Ledger, hash16  # noqa: E402
from qa.vendor_pin import drift  # noqa: E402

needs_clone = pytest.mark.skipif(not (v.CLONE / ".git").exists(), reason="MEME's clone is not on this box")
needs_data = pytest.mark.skipif(not v.DATA.exists(), reason="meme_filler32k.json is not on this box")


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def test_the_published_setup_is_pinned():
    assert (v.COMMIT, v.HF_REVISION, v.MINI, v.FOUR_O, v.TOPK) == (
        "cb8164d8e5a5e07d974502e828262dfc9ec88d1b", "e14c4e685772014deb96f91dc7eddfbeb21d90d8",
        "gpt-4.1-mini-2025-04-14", "gpt-4o-2024-08-06", 20)
    assert v.ANSWERER == ol.Settings("gpt-4.1-mini-2025-04-14", temperature=0.0, max_tokens=500)
    assert v.JUDGE == ol.Settings("gpt-4o-2024-08-06", temperature=0.0, json_object=True)
    assert v.TASKS == ("ER", "Agg", "Tr", "Del", "Cas", "Abs") and v.FILTERED == ("Cas", "Abs", "Del")


@needs_clone
def test_the_clone_is_the_pinned_code_and_the_prompt_and_context_are_its_text():
    assert drift(v.CLONE, v.COMMIT, v.BLOBS) == []
    assert sha(v.prompt("C", "Q?")) == "48397fad5808470c6d2ee312ae983a03606537d8cfc62c93b8e770418ef4ca9d"
    assert v.context([{"memory": "user: a", "score": 0.916}, {"memory": "assistant: b", "score": 0.5}]) == \
        "[score=0.92] user: a\n[score=0.50] assistant: b"
    assert v.context([]) == "(no relevant facts)"


@needs_data
def test_the_data_gives_the_papers_questions_and_each_store_holds_what_run_episode_feeds():
    qs = mh.all_questions()
    assert len(v.episodes()) == 100 and len(qs) == 1188 and sum(q["phase"] == "before" for q in qs) == 494
    after = [q for q in qs if q["phase"] == "after"]
    assert {t: sum(q["task"] == t for q in after) for t in v.TASKS} == {
        "ER": 100, "Agg": 100, "Tr": 100, "Del": 100, "Cas": 164, "Abs": 130}
    ep = v.episodes()[0]
    turns = dict(mh.conversations())["meme-pl_001"]
    b, a = mh.fed(ep)
    assert len(turns) == sum(len(s["conversation"]) for s in ep["sessions"][:a])
    assert {q["ask_after"] for q in qs if q["episode"] == "pl_001"} == {len(mh.turns_of(ep, b)), len(turns)}
    by = {q["qid"]: q for q in qs}
    assert [(by[i]["phase"], by[i]["task"]) for i in mh.SMOKE] == [
        ("before", "Del"), ("after", "Del"), ("after", "ER"), ("after", "Tr"), ("after", "Agg")]
    assert v.epoch("2023/03/01 (Wed) 09:00") == 1677661200


def test_answers_and_judges_send_what_meme_sends(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    spend = tmp_path / "spend"
    answer = ol.OpenAIChat(tmp_path / "a.jsonl", v.ANSWERER, spend=spend)
    assert json.loads(answer._body("", "p")) == {"model": "gpt-4.1-mini-2025-04-14", "temperature": 0.0,
                                                 "messages": [{"role": "user", "content": "p"}], "max_tokens": 500}
    judge = ol.OpenAIChat(tmp_path / "j.jsonl", v.JUDGE, spend=spend)
    assert json.loads(judge._body("", "p")) == {"model": "gpt-4o-2024-08-06", "temperature": 0.0,
                                                "messages": [{"role": "user", "content": "p"}],
                                                "response_format": {"type": "json_object"}}
    assert (answer.pool, judge.pool) == ("small", "big")


def test_a_judge_reply_is_valid_only_as_a_json_object():
    assert v.judge_parse('{"correct": true}') == {"correct": True}
    assert v.judge_parse('```json\n{"correct": false}\n```') == {"correct": False}
    assert v.judge_parse("[1]") is None and v.judge_parse("no") is None and v.judge_parse("```") is None


def record(user: str, text: str) -> dict:
    return {"tag": "t", "sys": hash16(""), "user": hash16(user), "effort": v.EFFORT, "cli": v.JUDGE.cli,
            "event": "ok", "models": [v.FOUR_O], "text": text, "usage": {"prompt_tokens": 7, "completion_tokens": 3},
            "ts": 0.0}


def ask(client: v.LedgerClient, user: str, **kw):
    args = {"model": "gpt-4o", "temperature": 0, "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": user}], **kw}
    return client.chat.completions.create(**args)


def test_the_judge_client_reads_the_first_valid_reply_lists_open_calls_and_raises_on_none(tmp_path):
    log = write_log(tmp_path / "calls-judge.jsonl", [record("u1", "nope"), record("u1", '{"correct": true}'),
                                                      *(record("u3", "x") for _ in range(3))])
    client = v.LedgerClient(Ledger(log), None, "t")
    got = ask(client, "u1")
    assert json.loads(got.choices[0].message.content) == {"correct": True} and got.usage.prompt_tokens == 7
    with pytest.raises(v.NoReply, match="open"):
        ask(client, "u2")
    with pytest.raises(v.NoReply, match="exhausted"):
        ask(client, "u3")
    assert client.open == [("t", hash16("u2"))]
    with pytest.raises(RuntimeError, match="unexpected judge call"):
        ask(client, "u1", temperature=0.5)


def test_cascade_absence_and_deletion_count_only_a_real_pass_and_smoke_items_stay_out():
    res = {"e": {"after_answers": [
        {"qid": "e-a0", "task_type": "Del", "u_pass": True, "pass_type": "trivial"},
        {"qid": "e-a1", "task_type": "Cas", "u_pass": True, "pass_type": "real"},
        {"qid": "e-a2", "task_type": "Abs", "u_pass": False, "pass_type": "knew_but_failed"},
        {"qid": "e-a3", "task_type": "ER", "u_pass": True}, {"qid": "e-a4", "task_type": "Tr", "u_pass": False},
        {"qid": "e-a5", "task_type": "Agg", "u_pass": True}]}}
    got = mh.task_scores(res, {f"e-a{i}" for i in range(6)} - {"e-a5"})
    assert got == {"ER": (1, 1), "Agg": (0, 0), "Tr": (0, 1), "Del": (0, 1), "Cas": (1, 1), "Abs": (0, 1)}
