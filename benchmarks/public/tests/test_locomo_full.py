"""mem0/locomo_full.py (dated notes 20): every category 1 to 4 question by h2h's name, and a verdict item equal to
rescore_official's for the same answer, so the 400 sample verdicts are reused and never asked again."""
from __future__ import annotations

import json

import pytest
from conftest import RUNNER

pytest.importorskip("aiolimiter", reason="the runner modules import only with the runner venv's packages")
if not (RUNNER / "benchmarks" / "locomo" / "prompts.py").exists():
    pytest.skip("h2h imports Mem0's runner checkout", allow_module_level=True)

import locomo_full as lf  # noqa: E402
import rescore_official as ro  # noqa: E402


def test_all_qids_keep_the_qa_index_and_drop_category_5():
    data = [{"qa": [{"category": 1}, {"category": 5}, {"category": 4}]}, {"qa": [{"category": 2}]}]
    assert lf.all_qids(data) == ["conv0_q0", "conv0_q2", "conv1_q0"]


def test_a_verdict_item_equals_the_rescores(tmp_path):
    data = [{"qa": [{"question": "Where?", "answer": "Paris", "category": 4}]}]
    (tmp_path / "answers.jsonl").write_text(json.dumps({"arm": "hippo-emb", "cutoff": 200, "qid": "conv0_q0",
                                                        "answer": "In Paris"}) + "\n", encoding="utf-8")
    (tmp_path / "judge_key.json").write_text(json.dumps({"j1": {"arm": "hippo-emb", "cutoff": 200, "qid": "conv0_q0"}}),
                                             encoding="utf-8")
    (tmp_path / "verdicts.jsonl").write_text(json.dumps({"id": "j1", "label": "CORRECT"}) + "\n", encoding="utf-8")
    theirs = ro.locomo_items(tmp_path, data)[("hippo-emb", "200", "conv0_q0")][0]
    ours = lf.judge_item(data[0]["qa"][0], "conv0_q0", "In Paris")
    assert (ours.key, ours.user, ours.manifest) == (theirs.key, theirs.user, theirs.manifest)
