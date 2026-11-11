"""qa/harness.py on a synthetic benchmark: answers resume from the call log, scores read only the log, smoke items stay
out of the primary, the interval resamples the store-owning user, and a short search list is a real result."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import types

import pytest
from conftest import RUNNER, rec, write_log

if not (RUNNER / "benchmarks" / "locomo" / "prompts.py").exists():
    pytest.skip("h2h, which harness imports, needs Mem0's runner checkout", allow_module_level=True)

import harness  # noqa: E402
import h2h  # noqa: E402
import qa.ledger as ledger  # noqa: E402
from qa.ledger import ANSWERER, Item  # noqa: E402

QS = [{"qid": f"q{i}", "user_id": f"u{i // 2}", "question": f"question {i}", "gold": "yes", "category": "c",
       "ask_after": None} for i in range(6)]


def fake_loader() -> types.ModuleType:
    mod = types.ModuleType("loaders.fakebench")
    mod.NAME, mod.TOPK, mod.LICENCE, mod.DATA_FILES = "Fake", 5, "none", []
    mod.questions = lambda: [dict(q) for q in QS]
    mod.answer_prompt = lambda q, mems: (f"system for {q['qid']}", f"{q['question']} with {len(mems)} memories")
    mod.judge = lambda q, answer: ("match", answer.strip() == q["gold"])
    return mod


@pytest.fixture
def bench(tmp_path, monkeypatch):
    """An out folder after retrieval: questions, config, predicted files and their manifest; q5 is a smoke item."""
    monkeypatch.setitem(sys.modules, "loaders.fakebench", fake_loader())
    monkeypatch.setattr(ledger, "SMOKE", tmp_path / "smoke.json")
    (tmp_path / "smoke.json").write_text('{"fakebench": ["q5"]}', encoding="utf-8")
    out = tmp_path / "out"
    manifest: dict = {}
    for arm in harness.ARMS:
        for q in QS:
            p = harness.pred_path(out, arm, q["qid"])
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(json.dumps({"results": [{"memory": "m"}]}).encode())
            manifest.setdefault(arm, {})[q["qid"]] = hashlib.sha256(p.read_bytes()).hexdigest()
    (out / "predicted" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (out / "questions.json").write_text(json.dumps({"qids": [q["qid"] for q in QS]}), encoding="utf-8")
    (out / "config.json").write_text(json.dumps({"limit": 0}), encoding="utf-8")
    a = argparse.Namespace(stage="score", bench="fakebench", out=out, limit=0, slots=2, port_base=0, bonferroni=4)
    mod, qs = harness.setup(a)
    return a, mod, qs


def answer(arm: str, qid: str, **kw) -> dict:
    q = QS[int(qid[1:])]
    return rec(f"answer {arm} {qid}", f"{q['question']} with 1 memories", system=f"system for {qid}", **kw)


def full_log(out, hippo: dict, bm25: dict) -> None:
    """One valid reply per (arm, qid) with the given text."""
    write_log(out / "calls-answer.jsonl", [answer(arm, qid, text=t) for arm, plan in (("hippo365", hippo), ("bm25", bm25))
                                           for qid, t in plan.items()])


def test_score_reads_the_log_leaves_smoke_out_and_lists_exhausted(bench):
    a, mod, qs = bench
    full_log(a.out, {"q0": "yes", "q1": "yes", "q2": "yes", "q3": "no", "q4": "yes", "q5": "yes"},
             {"q0": "no", "q3": "yes", "q4": "yes", "q5": "no"})
    with (a.out / "calls-answer.jsonl").open("a", encoding="utf-8") as f:  # q1 exhausted; q2 valid at its 2nd ask
        for r in [answer("bm25", "q1", cli="2.1.400 (Claude Code)")] * 3 + [
                answer("bm25", "q2", model="claude-opus-5", text="no"), answer("bm25", "q2")]:
            f.write(json.dumps(r) + "\n")
    (a.out / "answers.jsonl").write_text(json.dumps({"arm": "bm25", "qid": "q0", "answer": "yes"}) + "\n", encoding="utf-8")
    harness.stage_score(a, mod, qs)
    text = (a.out / "score.txt").read_text(encoding="utf-8")
    assert "hippo365  accuracy  80.0" in text and "bm25  accuracy  60.0" in text  # answers.jsonl is never read
    assert "PRIMARY hippo365 - bm25 all: +20.0 pp" in text and "n=5 over 3 units" in text
    assert "secondary, all items with the smoke items: +33.3 pp" in text and "n=6 over 3 units" in text
    assert "Bonferroni k=4, 98.75% interval: +20.0 pp" in text
    assert "smoke items left out of every primary: q5" in text
    assert "answers exhausted after 3 asks, scored wrong: 1" in text and "('bm25', 'q1'): cli" in text


def test_score_stops_while_an_answer_has_asks_left(bench):
    a, mod, qs = bench
    full_log(a.out, {q["qid"]: "yes" for q in QS}, {q["qid"]: "yes" for q in QS if q["qid"] != "q4"})
    with (a.out / "calls-answer.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(answer("bm25", "q4", effort="low")) + "\n")
    with pytest.raises(SystemExit, match="answers: 1 of 12 not settled"):
        harness.stage_score(a, mod, qs)


def test_answer_resume_reuses_the_log_and_never_passes_three_asks(bench, monkeypatch):
    a, mod, qs = bench
    write_log(a.out / "calls-answer.jsonl", [answer("hippo365", "q0"), *[answer("hippo365", "q1", effort="low")] * 3,
                                             answer("hippo365", "q2", effort="low")])
    asked: list[str] = []

    class FakeClaude:
        def __init__(self, work, log, slots) -> None:
            self.cli = ANSWERER.cli

        def ask(self, system: str, user: str, *, effort: str, tag: str) -> dict:
            asked.append(tag)
            return answer(tag.split()[1], tag.split()[2])

    monkeypatch.setattr(harness, "Claude", FakeClaude)
    harness.stage_answer(a, mod, qs)
    assert sorted(asked) == sorted([f"answer hippo365 q{i}" for i in (2, 3, 4, 5)] + [f"answer bm25 q{i}" for i in range(6)])
    trail = [json.loads(line) for line in (a.out / "answers.jsonl").read_text(encoding="utf-8").splitlines()]
    assert {(r["qid"], r["asks"]) for r in trail if r["arm"] == "hippo365"} == {("q2", 2), ("q3", 1), ("q4", 1), ("q5", 1)}


def test_the_unit_is_the_user_unless_one_store_holds_every_question():
    assert harness.units(QS) == {q["qid"]: q["user_id"] for q in QS}
    one = [{**q, "user_id": "hotpot24"} for q in QS]
    assert harness.units(one) == {q["qid"]: q["qid"] for q in QS}


class Srv:
    arm = "hippo365"

    def __init__(self, n: int) -> None:
        self.n = n

    def search(self, user: str, query: str, limit: int) -> list[dict]:
        return [{"id": i, "memory": "m", "score": 1.0, "created_at": None} for i in range(self.n)]


def test_a_short_search_list_is_a_real_result_and_a_long_one_fails(tmp_path):
    assert len(harness.search_for(Srv(7), QS[0], 20, 30)) == 7
    with pytest.raises(RuntimeError, match="at most 20 expected"):
        harness.search_for(Srv(21), QS[0], 20, 30)
    with pytest.raises(RuntimeError, match="at most 7 expected"):  # memories from turns not yet stored
        harness.search_for(Srv(8), QS[0], 20, 7)
    harness.write_pred(tmp_path, "hippo365", QS[0], harness.search_for(Srv(7), QS[0], 20, 12), 20, 12)
    assert json.loads(harness.pred_path(tmp_path, "hippo365", "q0").read_text(encoding="utf-8"))["returned"] == 7


def test_h2h_answers_come_from_the_log_and_exhausted_ones_hold_none(tmp_path, monkeypatch):
    items = {("hippo365", 200, "conv0_q1"): (3, Item("answer hippo365 200 conv0_q1", "", "p1", ANSWERER, h2h.answer_of)),
             ("bm25", 200, "conv0_q1"): (3, Item("answer bm25 200 conv0_q1", "", "p2", ANSWERER, h2h.answer_of))}
    monkeypatch.setattr(h2h, "answer_prompts", lambda a: items)
    write_log(tmp_path / "calls-answer.jsonl", [rec("answer hippo365 200 conv0_q1", "p1", text="why\nANSWER: Paris"),
                                                *[rec("answer bm25 200 conv0_q1", "p2", effort="low")] * 3])
    got = h2h.all_answers(argparse.Namespace(logs=tmp_path))
    assert got[("hippo365", 200, "conv0_q1")]["answer"] == "Paris"
    assert got[("bm25", 200, "conv0_q1")]["answer"] is None and got[("bm25", 200, "conv0_q1")]["choice"].asks == 3


def test_h2h_primary_has_the_conversation_sensitivity_and_bonferroni_lines():
    diff = {f"conv{c}_q{i}": float((c + i) % 3 - 1) for c in range(4) for i in range(5)}
    ids = sorted(diff)
    lines = h2h.primary_lines("hippo365 - mem0 F1 all", diff, ids[:-1], ids, str, 2)
    assert lines[0].startswith("PRIMARY hippo365 - mem0 F1 all:") and "n=19 over 19 units" in lines[0]
    assert "n=20 over 20 units" in lines[1] and lines[2].startswith("  Bonferroni k=2, 97.50% interval:")
    assert "n=20 over 4 units" in h2h.paired(diff, ids, lambda q: q.split("_q")[0])
