"""runner/rescore_official.py (dated notes 19): the published judge texts stay verbatim, both parses, the abstention
prompt, the competitor arm left out, and the preamble that answer_judge uses."""
from __future__ import annotations

import hashlib
import inspect
import json

import pytest
from conftest import RUNNER, rec, write_log

pytest.importorskip("aiolimiter", reason="the runner modules import only with the runner venv's packages")
if not (RUNNER / "benchmarks" / "beam" / "run.py").exists():
    pytest.skip("h2h imports Mem0's runner checkout", allow_module_level=True)

import rescore_official as ro  # noqa: E402
from qa import official_judges  # noqa: E402
from qa.ledger import JUDGE  # noqa: E402

# sha256 of the upstream texts: LongMemEval 9e0b455 evaluate_qa.py get_anscheck_prompt; mem0 aae5989e78 ACCURACY_PROMPT
FN_SHA = "90413115ed06dd07135f9d9ed53b14238776029eeb1a32a87ccbfbc0e2730482"
ACC_SHA = "62395dd312a631dfd9355026a0b69cc936018274c3198b6365b5c2a5c9bca9e0"


def test_the_published_texts_are_verbatim():
    fn = inspect.getsource(official_judges.get_anscheck_prompt).rstrip()
    assert hashlib.sha256(fn.encode()).hexdigest() == FN_SHA
    assert hashlib.sha256(official_judges.ACCURACY_PROMPT.encode()).hexdigest() == ACC_SHA


@pytest.mark.parametrize("reply,want", [("yes", True), ("No.", False), ("Yes, it does.", True), ("", None), ("maybe", None)])
def test_yes_in_reads_the_reply_as_evaluate_qa_does(reply, want):
    assert ro.yes_in(reply) is want


@pytest.mark.parametrize("reply,want", [('{"label": "CORRECT"}', True), ('```json\n{"label": "WRONG"}\n```', False),
                                        ("The answer matches. CORRECT", None), ('{"label": "PARTIAL"}', None)])
def test_label_in_reads_the_json_label(reply, want):
    assert ro.label_in(reply) is want


def test_an_abstention_id_gets_the_unanswerable_prompt(tmp_path):
    rec = {"arm": "hippo365", "result": {"question_id": "q1_abs", "question_type": "multi-session", "question": "Q?",
                                         "ground_truth_answer": "never said", "cutoff_results": {
                                             "top_10": {"generated_answer": "I don't know", "score": 1.0}}}}
    (tmp_path / "results.jsonl").write_text(json.dumps(rec) + "\n", encoding="utf-8")
    item, old = ro.lme_items(tmp_path)[("hippo365", "top_10", "q1_abs")]
    assert item.user.startswith("I will give you an unanswerable question") and old is True


def test_the_competitor_arm_is_never_judged(tmp_path):
    data = [{"qa": [{"question": "Where?", "answer": "Paris", "category": 4}]}]
    answers = [{"arm": arm, "cutoff": 10, "qid": "conv0_q0", "answer": "Paris"} for arm in ("hippo365", "mem0")]
    (tmp_path / "answers.jsonl").write_text("".join(json.dumps(a) + "\n" for a in answers), encoding="utf-8")
    (tmp_path / "judge_key.json").write_text(json.dumps({"j1": {"arm": "hippo365", "cutoff": 10, "qid": "conv0_q0"},
                                                         "j2": {"arm": "mem0", "cutoff": 10, "qid": "conv0_q0"}}), encoding="utf-8")
    (tmp_path / "verdicts.jsonl").write_text("".join(json.dumps({"id": j, "label": "CORRECT"}) + "\n" for j in ("j1", "j2")),
                                             encoding="utf-8")
    items = ro.locomo_items(tmp_path, data)
    assert list(items) == [("hippo365", "10", "conv0_q0")]
    assert "Gold answer: Paris" in items[("hippo365", "10", "conv0_q0")][0].user


def test_the_preamble_is_answer_judges():
    import answer_judge  # noqa: F401  (sets codex_judge.PREAMBLE at import)
    import codex_judge
    assert ro.PREAMBLE == codex_judge.PREAMBLE


def test_only_keeps_one_arm_and_cutoff_and_scores_into_its_own_file(tmp_path, monkeypatch):
    recs = [{"arm": "hippo-emb", "result": {"question_id": "q1", "question_type": "multi-session", "question": "Q?",
                                            "ground_truth_answer": "A", "cutoff_results": {
                                                c: {"generated_answer": "A", "score": 1.0} for c in ("top_10", "top_200")}}}]
    (tmp_path / "results.jsonl").write_text("".join(json.dumps(r) + "\n" for r in recs), encoding="utf-8")
    items = ro.items_of("longmemeval-s", tmp_path, ("hippo-emb:top_200",))
    assert list(items) == [("hippo-emb", "top_200", "q1")]
    with pytest.raises(SystemExit, match="matches no"):
        ro.items_of("longmemeval-s", tmp_path, ("hippo-emb:top_50",))
    (tmp_path / ro.SUBS["codex"]).mkdir()
    item = items[("hippo-emb", "top_200", "q1")][0]
    write_log(tmp_path / ro.SUBS["codex"] / "calls-judge.jsonl", [rec(item.tag, item.user, model=JUDGE.model, cli=JUDGE.cli)])
    monkeypatch.setattr(ro, "smoke_excluded", lambda bench, ids: set())
    ro.score("longmemeval-s", tmp_path, ("hippo-emb:top_200",))
    assert not (tmp_path / ro.SUBS["codex"] / "score.txt").exists()
    got = json.loads((tmp_path / ro.SUBS["codex"] / "score-hippo-emb-top_200.json").read_text(encoding="utf-8"))
    assert got["hippo-emb top_200"]["official_all"] == 100.0
