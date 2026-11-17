"""mem0/dmr_openai.py: Zep's DMR notebook verbatim, its A/B transcript, its answer and grader requests, and the check."""
from __future__ import annotations

import hashlib
import json

import dmr_openai as do
import pytest
from qa import harness
from qa import zep_dmr_prompts as zp
from qa.ledger import Choice
from qa.loaders import dmr

sha = lambda text: hashlib.sha256(text.encode()).hexdigest()  # noqa: E731


@pytest.mark.parametrize("name,want", [
    ("ANSWER_SYSTEM", "6437d8a98a61766ff6add3a824812952f9e4db39b4da9e341288d74caf3bc7eb"),
    ("ANSWER_PROMPT", "f77ef38dbe86a1ebae6a0fc898ca03c7ad8c274bec12a4891ea192c93c1aa3d5"),
    ("GRADER_SYSTEM", "24549d3e283e5226612246aa5a73a31c8d3efe20a1df3b43e2e53c7a0cb653a0"),
    ("GRADER_PROMPT", "1f773da05de7e97dbbba89589faafce57dc528184aa9b4c556b38f807b1bb7f9")])
def test_the_prompts_are_zeps_text(name, want):
    """sha256 at getzep/zep 1659df1a zep_memgpt_eval.ipynb cell 8 (vendor_zep_dmr.py, 17 Nov), f-strings as templates."""
    assert sha(getattr(zp, name)) == want


def test_the_grader_asks_for_zeps_grade_object():
    fmt = json.loads(zp.GRADE_FORMAT)
    assert fmt["type"] == "json_schema" and fmt["json_schema"]["name"] == "Grade" and fmt["json_schema"]["strict"]
    assert fmt["json_schema"]["schema"]["required"] == ["is_correct"]


@pytest.mark.parametrize("row,want", [
    (0, "6ee761a8af12ee728d02be1f755913307dc6063ba1c3786909174493e2aa36ea"),
    (18, "213e47fa714a7d9f9393423feb543327a98562a958b6a46cf2959b88a2bcf936")])
def test_the_full_context_is_zeps_full_conversation(row, want):
    """sha256 of the notebook's own full_conversation (cells 3 and 9) on the row, made by vendor_zep_dmr.py."""
    q = dmr.questions()[row]
    assert sha(do.contexts("full", [q])[q["qid"]]) == want


def test_the_answer_is_zeps_prompt_over_the_context_and_question():
    q = dmr.questions()[0]
    item = do.answer_items("full", [q])[q["qid"]]
    assert item.system == zp.ANSWER_SYSTEM and "speaker A" in item.system
    assert item.user == zp.ANSWER_PROMPT.format(context=do.contexts("full", [q])[q["qid"]], question=q["question"])
    assert "NO ANSWER" not in item.user + item.system and "best match first" not in item.user + item.system


def test_a_retrieval_arm_relabels_its_turns_in_rank_order(tmp_path, monkeypatch):
    q = dmr.questions()[0]
    raw = json.dumps({"results": [{"memory": "Speaker 2: second: yes"}, {"memory": "Speaker 1: first"}]}).encode()
    path = harness.pred_path(tmp_path, "hippo-emb", q["qid"])
    path.parent.mkdir(parents=True)
    path.write_bytes(raw)
    (tmp_path / "predicted" / "manifest.json").write_text(json.dumps({"hippo-emb": {q["qid"]: harness.sha_bytes(raw)}}))
    monkeypatch.setitem(do.RETRIEVED, "hippo-emb", tmp_path)
    assert do.contexts("hippo-emb", [q]) == {q["qid"]: "B: second: yes\nA: first\n"}


def test_the_grader_reads_the_whole_answer_after_zeps_b_and_a_marks():
    q = dmr.questions()[0]
    answer = "ANSWER: Taylor Swift\nEVIDENCE: A: I can get into taylor swift."
    items, settled = do.judge_items("full", [q], {q["qid"]: Choice("valid", 1, answer)})
    user = items[q["qid"]].user
    assert settled == {} and f"B: {q['question']}\n" in user and f"A: {answer}\n" in user
    assert f"<CORRECT ANSWER>\n    {q['gold']}\n" in user and items[q["qid"]].system == zp.GRADER_SYSTEM
    assert do.judge_items("full", [q], {q["qid"]: Choice("exhausted", 3)}) == ({}, {q["qid"]: False})


@pytest.mark.parametrize("reply,want", [('{"is_correct": true}', True), ('{"is_correct": false}', False),
                                        ('{"is_correct": "true"}', None), ("true", None), ("", None)])
def test_a_grade_is_the_grade_objects_boolean(reply, want):
    assert do.grade(reply) is want


def test_answer_and_grade_leave_as_zeps_requests(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    msgs = [{"role": "system", "content": "sys"}, {"role": "user", "content": "q"}]
    answer = do.OpenAIChat(tmp_path / "a.jsonl", do.ANSWERER, slots=1, spend=tmp_path / "spend", cap=1.0)
    assert json.loads(answer._body("sys", "q")) == {"model": "gpt-4o-mini-2024-07-18", "temperature": 0.0, "messages": msgs}
    grader = do.OpenAIChat(tmp_path / "g.jsonl", do.GRADER, slots=1, spend=tmp_path / "spend", cap=1.0)
    assert json.loads(grader._body("sys", "q")) == {"model": "gpt-4o-mini-2024-07-18", "temperature": 0.0,
                                                    "messages": msgs, "response_format": json.loads(zp.GRADE_FORMAT)}
    assert do.ANSWERER.cli == "openai chat.completions role=user temperature=0.0 max_tokens=None json_object=False"
    assert do.GRADER.cli.startswith(do.ANSWERER.cli + " response_format=")


def test_the_harness_check_reads_zeps_full_conversation_row():
    assert do.check_line("full", 490, 500)[0].startswith("harness check: full PASS")
    assert do.check_line("full", 480, 500)[0].startswith("harness check: full PASS")
    assert do.check_line("full", 477, 500)[0].startswith("harness check: full FAIL")
    assert do.check_line("full", 462, 500)[0].startswith("harness check: full FAIL")  # the 92.4 of dated notes 26
    assert do.check_line("hippo-best", 250, 500) == []
