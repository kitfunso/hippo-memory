"""runner/answer_judge.py and runner/score.py on the ledger: replay takes the first valid reply in 3 asks, an exhausted
judge step takes the runner's own fallback, an exhausted answer scores the question 0, and the store-owning units."""
from __future__ import annotations

import asyncio
import contextvars
from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import RUNNER, rec, write_log

pytest.importorskip("aiolimiter", reason="the runner modules import only with the runner venv's packages")
if not (RUNNER / "benchmarks" / "beam" / "run.py").exists():
    pytest.skip("answer_judge imports Mem0's runner checkout", allow_module_level=True)

import answer_judge as aj  # noqa: E402
import codex_judge  # noqa: E402
import score  # noqa: E402
from qa.ledger import ANSWERER, JUDGE  # noqa: E402


def judge_rec(tag: str, user: str, system: str = "", **kw) -> dict:
    return rec(tag, user, system=system, model=JUDGE.model, cli=JUDGE.cli, **kw)


def in_ctx(fn, *args):
    """Runs one Backend call as the runner does, with (arm, qid) in its own context."""
    ctx = contextvars.copy_context()
    ctx.run(aj.CTX.set, ("bm25", "q1"))
    return ctx.run(fn, *args)


def test_structured_takes_the_first_usable_reply_and_falls_back_to_empty(tmp_path):
    tag = f"judge bm25 q1 {aj.sha('grade it')[:8]}"
    write_log(tmp_path / "calls-judge.jsonl", [judge_rec(tag, "a", "grade it", text="nope"),
                                               judge_rec(tag, "a", "grade it", text='{"score": 1}'),
                                               *[judge_rec(tag, "b", "grade it", text="nope")] * 3])
    be = aj.Backend(tmp_path, 1, 1, live=False)
    assert in_ctx(be.structured, "grade it", "a") == {"score": 1}
    assert in_ctx(be.structured, "grade it", "b") == {}
    assert [(t["status"], t["asks"]) for t in be.trace[("bm25", "q1")]] == [("valid", 2), ("exhausted", 3)]


def test_yes_no_asks_again_on_neither_word_and_counts_an_exhausted_item_as_no(tmp_path):
    tag = f"judge bm25 q1 {aj.sha('')[:8]}"
    write_log(tmp_path / "calls-judge.jsonl", [judge_rec(tag, "a", text="unsure"), judge_rec(tag, "a", text="Yes."),
                                               *[judge_rec(tag, "b", text="unsure")] * 3])
    be = aj.Backend(tmp_path, 1, 1, live=False)
    assert in_ctx(be.yes_no, "a") == (True, "Yes.")
    assert in_ctx(be.yes_no, "b") == (False, "")


def test_an_exhausted_answer_raises_and_an_open_one_is_a_missing_reply(tmp_path):
    tag = f"answer bm25 q1 {aj.sha('sys')[:8]}"
    write_log(tmp_path / "calls-answer.jsonl", [rec(tag, "a", system="sys", cli="2.1.400 (Claude Code)")] * 3)
    be = aj.Backend(tmp_path, 1, 1, live=False)
    with pytest.raises(aj.Exhausted, match="answer bm25 q1: cli"):
        in_ctx(be.answer, "sys", "a")
    with pytest.raises(aj.MissingReply):
        in_ctx(be.answer, "sys", "never asked")
    assert ANSWERER.cli != "2.1.400 (Claude Code)"


@pytest.fixture
def fake_lme(monkeypatch):
    """The runner's LongMemEval step reduced to one answer and one yes/no verdict through the adapters."""
    async def apply(res, ans, jdg, cutoffs):
        text = await ans.generate("sys", "a")
        ok, _ = await jdg.judge_yes_no(text)
        res["cutoff_results"] = {"top_200": {"score": float(ok)}}

    monkeypatch.setattr(aj.lme, "apply_longmemeval_answerer_judge_to_saved_result", apply)


def evaluate(tmp_path) -> dict:
    be, pool = aj.Backend(tmp_path, 1, 1, live=False), ThreadPoolExecutor(2)
    saved = {"question_type": "single-session-user", "retrieval": {}}
    return in_ctx(asyncio.run, aj.evaluate("longmemeval-s", saved, be, pool))


def test_evaluate_scores_an_exhausted_answer_as_a_result_with_no_cutoffs(tmp_path, fake_lme):
    write_log(tmp_path / "calls-answer.jsonl", [rec(f"answer bm25 q1 {aj.sha('sys')[:8]}", "a", system="sys",
                                                    effort="low")] * 3)
    res = evaluate(tmp_path)
    assert set(res) == {"question_type", "exhausted"} and res["exhausted"][0].startswith("answer bm25 q1: effort")


def test_evaluate_names_an_exhausted_verdict_and_leaves_the_key_out_otherwise(tmp_path, fake_lme):
    write_log(tmp_path / "calls-answer.jsonl", [rec(f"answer bm25 q1 {aj.sha('sys')[:8]}", "a", system="sys",
                                                    text="Paris")])
    judge = f"judge bm25 q1 {aj.sha('')[:8]}"
    write_log(tmp_path / "calls-judge.jsonl", [judge_rec(judge, "Paris", text="unsure")] * 3)
    assert evaluate(tmp_path) == {"question_type": "single-session-user", "exhausted": [judge],
                                  "cutoff_results": {"top_200": {"score": 0.0}}}
    write_log(tmp_path / "calls-judge.jsonl", [judge_rec(judge, "Paris", text="yes")])
    assert "exhausted" not in evaluate(tmp_path)


def test_the_unit_is_the_question_for_longmemeval_and_the_conversation_for_beam():
    assert score.unit_of("longmemeval-s")("e47becba") == "e47becba"
    assert score.unit_of("beam-100k")("100K_3_q12_event_ordering") == "100K_3"  # beam/run.py builds this id


@pytest.mark.parametrize("bench,metrics", [("longmemeval-s", ("acc@200", "acc@10")), ("beam-100k", ("score", "pass"))])
def test_a_question_without_cutoff_results_scores_zero(bench, metrics):
    m = score.per_question(bench, {("bm25", "q1"): {"result": {"question_type": "t", "exhausted": ["answer bm25 q1"]}}})
    assert [m[k][("bm25", "q1")] for k in metrics] == [0.0, 0.0] and m["type"]["q1"] == "t"


def test_beam_lines_leave_smoke_out_and_resample_conversations():
    ids = ["100K_0_q0_a", "100K_0_q1_a", "100K_1_q0_a", "100K_1_q1_b"]
    vals = {"hippo365": [1.0, 1.0, 0.0, 1.0], "bm25": [0.0, 1.0, 0.0, 0.0]}
    m = {"type": {q: q[-1] for q in ids}, **{k: {(arm, q): v[i] for arm, v in vals.items() for i, q in enumerate(ids)}
                                             for k in ("score", "pass")}}
    lines, pairs = score.metric_lines("beam-100k", m, ids, ids[:3], ["hippo365", "bm25"], 2)
    assert " hippo365  n=3  mean  66.7" in lines and "n=3 over 2 units" in next(x for x in lines if x.startswith("PRIMARY"))
    assert any(x.startswith("  Bonferroni k=2, 97.50% interval:") for x in lines)
    assert (pairs["score/all"]["n"], pairs["score/all"]["units"]) == (3, 2) and "score/b" not in pairs


def test_the_runner_preamble_replaces_the_json_one():
    assert codex_judge.PREAMBLE.startswith("You are a grading function. Do NOT use any tool.")
    assert "JSON" not in codex_judge.PREAMBLE
