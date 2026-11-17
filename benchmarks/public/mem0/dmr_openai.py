"""DMR as Zep's released notebook runs it: gpt-4o-mini answers and grades, over hippo's registered retrievals.

The Zep paper's gpt-4o-mini DMR rows (full conversation 98.0, Zep 98.2) come from getzep/zep 1659df1a
`benchmarks/longmemeval/zep_memgpt_eval.ipynb`: an A/B transcript, Zep's own answer prompt and a gpt-4o-mini grader
(`qa/zep_dmr_prompts.py`, copied by script). MemGPT's 6.1.1 prompt with codex's 6.1.2 judge held `full` at 92.4
(prereg dated notes 26 and 31; ~/hippo-bench/comparability/lane-dmr-fix.md).
Usage (runner venv): python -I dmr_openai.py {answer,judge,score} --arm {full,hippo-best,hippo-emb,hippo365,bm25} [--limit N]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent), str(HERE.parent / "qa")]
from qa import harness  # noqa: E402
from qa import zep_dmr_prompts as zp  # noqa: E402
from qa.ledger import Item, Ledger, Manifest, exhausted_lines, one_writer, require, smoke_excluded, unsettled  # noqa: E402
from qa.loaders import dmr  # noqa: E402
from qa.openai_llm import EFFORT, OpenAIChat, Settings  # noqa: E402

R2 = Path.home() / "hippo-bench" / "results-r2"
RETRIEVED = {"full": None, "hippo-best": R2 / "dmr-best", "hippo-emb": R2 / "dmr-emb", "hippo365": R2 / "dmr",
             "bm25": R2 / "dmr"}
OUT = R2 / "dmr-zep-gpt4omini"
# The notebook's answer model "gpt-4-mini" is no OpenAI model; the paper names gpt-4o-mini, and its grader the alias
ANSWERER = Settings("gpt-4o-mini-2024-07-18")
GRADER = Settings("gpt-4o-mini-2024-07-18", response_format=zp.GRADE_FORMAT)
ANSWER_M, GRADER_M = Manifest(ANSWERER.model, EFFORT, ANSWERER.cli), Manifest(GRADER.model, EFFORT, GRADER.cli)
LABEL = {"Speaker 1": "A", "Speaker 2": "B"}  # Zep labels a session's even turns A, as the loader labels them Speaker 1
ZEP_FULL, ZEP_N = 490, 500  # Zep paper Table 1: full conversation 98.0% of the 500 rows with gpt-4o-mini


def transcript(turns: list[tuple[str, str]]) -> str:
    """Zep's context: one 'A: text' or 'B: text' line per turn, each ending in a newline (notebook cell 9)."""
    return "".join(f"{LABEL[who]}: {text}\n" for who, text in turns)


def contexts(arm: str, qs: list[dict]) -> dict[str, str]:
    """`full` is every turn's raw text, as Zep's baseline reads the data; a retrieval arm is its registered top 20."""
    if arm == "full":
        convs = dict(dmr.conversations())
        return {q["qid"]: transcript([(t["role"], t["content"]) for t in convs[q["user_id"]]]) for q in qs}
    mod = SimpleNamespace(answer_prompt=lambda q, res: (
        transcript([tuple(m["memory"].split(": ", 1)) for m in res]), q["question"]))
    prompts = harness.prompts_of(argparse.Namespace(out=RETRIEVED[arm], arms=[arm]), mod, qs)  # checks each file's hash
    return {qid: p[2] for (_, qid), p in prompts.items()}


def answer_items(arm: str, qs: list[dict]) -> dict[str, Item]:
    ctx = contexts(arm, qs)
    return {q["qid"]: Item(f"dmr zep answer {arm} {q['qid']}", zp.ANSWER_SYSTEM,
                           zp.ANSWER_PROMPT.format(context=ctx[q["qid"]], question=q["question"]), ANSWER_M)
            for q in qs}


def answers_of(arm: str, out: Path, qs: list[dict]) -> dict:
    ledger, items = Ledger(out / "calls-answer.jsonl"), answer_items(arm, qs)
    got = {qid: ledger.choose(item) for qid, item in items.items()}
    unsettled(got, "answers")
    return got


def grade(reply: str) -> bool | None:
    """The Grade object's is_correct, or None when the reply holds none."""
    try:
        v = json.loads(reply)
    except ValueError:
        return None
    return v["is_correct"] if isinstance(v, dict) and isinstance(v.get("is_correct"), bool) else None


def judge_items(arm: str, qs: list[dict], answers: dict) -> tuple[dict[str, Item], dict[str, bool]]:
    """Every valid answer, whole, goes to Zep's grader; an exhausted answer scores wrong."""
    llm, settled = {}, {}
    for q in qs:
        c = answers[q["qid"]]
        if c.status != "valid":
            settled[q["qid"]] = False
            continue
        user = zp.GRADER_PROMPT.format(question=q["question"], gold_answer=q["gold"], response=c.value)
        llm[q["qid"]] = Item(f"dmr zep grade {arm} {q['qid']}", zp.GRADER_SYSTEM, user, GRADER_M, grade)
    return llm, settled


def settle_all(items: dict[str, Item], log: Path, settings: Settings, manifest: Manifest, slots: int) -> None:
    ledger, llm = Ledger(log), OpenAIChat(log, settings, slots=slots)
    require(llm, manifest)
    with ThreadPoolExecutor(slots) as pool:
        list(pool.map(lambda q: ledger.settle(items[q], llm), items))


def stage_answer(arm: str, out: Path, qs: list[dict], slots: int) -> None:
    items = answer_items(arm, qs)
    print(f"{arm}: {len(items)} answers into {out}", flush=True)
    settle_all(items, out / "calls-answer.jsonl", ANSWERER, ANSWER_M, slots)


def stage_judge(arm: str, out: Path, qs: list[dict], slots: int) -> None:
    items, _ = judge_items(arm, qs, answers_of(arm, out, qs))
    print(f"{arm}: {len(items)} grades", flush=True)
    settle_all(items, out / "calls-judge.jsonl", GRADER, GRADER_M, slots)


def check_line(arm: str, right: int, n: int) -> list[str]:
    """`full` against Zep's 490 of 500: PASS when a two-proportion z-test at 95% cannot tell the two apart."""
    if arm != "full":
        return []
    p = (right + ZEP_FULL) / (n + ZEP_N)
    se = math.sqrt(p * (1 - p) * (1 / n + 1 / ZEP_N))
    z = (right / n - ZEP_FULL / ZEP_N) / se if se else 0.0
    return [f"harness check: full {'PASS' if abs(z) < 1.96 else 'FAIL'} ({right} of {n}, {100 * right / n:.1f}, "
            f"against Zep's 98.0 of 500: z {z:+.2f})"]


def stage_score(arm: str, out: Path, qs: list[dict]) -> None:
    answers = answers_of(arm, out, qs)
    items, right = judge_items(arm, qs, answers)
    got = {qid: Ledger(out / "calls-judge.jsonl").choose(item) for qid, item in items.items()}
    unsettled(got, "grades")
    right |= {qid: c.status == "valid" and c.value for qid, c in got.items()}
    smoke = smoke_excluded("dmr", [q["qid"] for q in dmr.questions()])
    every, primary = [q["qid"] for q in qs], [q["qid"] for q in qs if q["qid"] not in smoke]
    acc = lambda ids: 100 * sum(right[q] for q in ids) / len(ids)
    lines = [f"DMR as Zep's notebook runs it, {arm}: answers and grades by {ANSWERER.model} with getzep/zep 1659df1a "
             f"zep_memgpt_eval.ipynb prompts (prereg dated notes 31)",
             f"accuracy {acc(every):5.2f}  n={len(every)}  all rows",
             f"accuracy {acc(primary):5.2f}  n={len(primary)}  primary",
             *check_line(arm, sum(right[q] for q in every), len(every))]
    lines += exhausted_lines(answers, "answers") + exhausted_lines(got, "grades")
    (out / "score.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("answer", "judge", "score"))
    ap.add_argument("--arm", choices=tuple(RETRIEVED), required=True)
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--limit", type=int, help="smoke: the first N questions, into OUT/smoke/ARM")
    a = ap.parse_args()
    qs = dmr.questions()[:a.limit] if a.limit else dmr.questions()
    out = OUT / "smoke" / a.arm if a.limit else OUT / a.arm
    if a.stage == "score":
        stage_score(a.arm, out, qs)
        return
    out.mkdir(parents=True, exist_ok=True)
    with one_writer(out):
        (stage_answer if a.stage == "answer" else stage_judge)(a.arm, out, qs, a.slots)


if __name__ == "__main__":
    main()
