"""DMR with gpt-4o-mini answers and a stated speaker role, over hippo's registered retrievals (prereg dated notes 26, lane D).

The Zep paper's DMR rows answer with gpt-4o-mini (full conversation 98.0, Zep 98.2). The registered prompt never says which
speaker the answerer is; MemGPT's generator (arXiv 2310.08560 appendix 6.1.3) has user B ask and user A answer, and A is
Speaker 1. ROLE adds that one line. The `full` arm runs first as the harness check: it passes in the published 94 to 98 band.
Usage (runner venv): python -I dmr_openai.py {answer,judge,score} --arm {full,hippo-best,hippo-emb,hippo365,bm25} [--limit N]
"""
from __future__ import annotations

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent), str(HERE.parent / "qa")]
from qa import harness  # noqa: E402
from qa.ledger import JUDGE, Item, Ledger, Manifest, exhausted_lines, one_writer, require, smoke_excluded, unsettled  # noqa: E402
from qa.loaders import dmr  # noqa: E402
from qa.openai_llm import EFFORT, OpenAIChat, Settings  # noqa: E402

R2 = Path.home() / "hippo-bench" / "results-r2"
RETRIEVED = {"full": R2 / "dmr-full", "hippo-best": R2 / "dmr-best", "hippo-emb": R2 / "dmr-emb",
             "hippo365": R2 / "dmr", "bm25": R2 / "dmr"}
OUT = R2 / "dmr-gpt4omini"
ANSWERER = Settings("gpt-4o-mini-2024-07-18")
MANIFEST = Manifest(ANSWERER.model, EFFORT, ANSWERER.cli)
FIRST = "Your task is to answer a question from the user about your prior conversations.\n"
ROLE = "In these conversations you are Speaker 1, and the user asking the question is Speaker 2.\n"
BAND = (94.0, 98.0)  # the Zep paper's full-conversation rows: 94.4 (gpt-4-turbo) and 98.0 (gpt-4o-mini)


def with_role(system: str) -> str:
    if not system.startswith(FIRST):
        sys.exit("the registered DMR system prompt changed; update FIRST before adding the role line")
    return FIRST + ROLE + system[len(FIRST):]


def answer_items(arm: str, qs: list[dict]) -> dict[str, Item]:
    prompts = harness.prompts_of(argparse.Namespace(out=RETRIEVED[arm], arms=[arm]), dmr, qs)
    return {qid: Item(f"dmr gpt4omini answer {arm} {qid}", with_role(p[2]), p[3], MANIFEST, lambda t: t)
            for (_, qid), p in prompts.items()}


def answers_of(arm: str, out: Path, qs: list[dict]) -> dict:
    ledger, items = Ledger(out / "calls-answer.jsonl"), answer_items(arm, qs)
    got = {qid: ledger.choose(item) for qid, item in items.items()}
    unsettled(got, "answers")
    return got


def judge_items(arm: str, qs: list[dict], answers: dict) -> tuple[dict[str, Item], dict[str, bool]]:
    """Every valid answer goes to the registered judge with the paper's 6.1.2 prompt; an exhausted answer scores wrong."""
    llm, settled = {}, {}
    for q in qs:
        c = answers[q["qid"]]
        if c.status != "valid":
            settled[q["qid"]] = False
            continue
        _, system, user, parse = dmr.judge(q, c.value)
        llm[q["qid"]] = Item(f"dmr gpt4omini judge {arm} {q['qid']}", system, user, JUDGE, parse)
    return llm, settled


def stage_answer(arm: str, out: Path, qs: list[dict], slots: int) -> None:
    ledger, items = Ledger(out / "calls-answer.jsonl"), answer_items(arm, qs)
    llm = OpenAIChat(out / "calls-answer.jsonl", ANSWERER, slots=slots)
    require(llm, MANIFEST)
    print(f"{arm}: {len(items)} answers into {out}", flush=True)
    with ThreadPoolExecutor(slots) as pool:
        list(pool.map(lambda q: ledger.settle(items[q], llm), items))


def stage_judge(arm: str, out: Path, qs: list[dict], slots: int) -> None:
    from codex_judge import CodexJudge  # noqa: E402
    items, _ = judge_items(arm, qs, answers_of(arm, out, qs))
    ledger, judge = Ledger(out / "calls-judge.jsonl"), CodexJudge(out / "calls-judge.jsonl", slots)
    require(judge, JUDGE)
    print(f"{arm}: {len(items)} verdicts", flush=True)
    with ThreadPoolExecutor(slots) as pool:
        list(pool.map(lambda q: ledger.settle(items[q], judge), items))


def band_line(arm: str, acc: float) -> list[str]:
    if arm != "full":
        return []
    lo, hi = BAND
    return [f"harness check: full {'PASS' if lo <= acc <= hi else 'FAIL'} ({acc:.1f} against the published {lo:.0f} to {hi:.0f})"]


def stage_score(arm: str, out: Path, qs: list[dict]) -> None:
    answers = answers_of(arm, out, qs)
    items, right = judge_items(arm, qs, answers)
    got = {qid: Ledger(out / "calls-judge.jsonl").choose(item) for qid, item in items.items()}
    unsettled(got, "verdicts")
    right |= {qid: c.status == "valid" and bool(c.value) for qid, c in got.items()}
    smoke = smoke_excluded("dmr", [q["qid"] for q in dmr.questions()])
    every, primary = [q["qid"] for q in qs], [q["qid"] for q in qs if q["qid"] not in smoke]
    acc = lambda ids: 100 * sum(right[q] for q in ids) / len(ids)
    none = sum(c.status == "valid" and "NO ANSWER" in c.value for c in answers.values())
    lines = [f"DMR with gpt-4o-mini answers and the Speaker 1 role, {arm}: {ANSWERER.model}, judged by {JUDGE.model} "
             f"with MemGPT appendix 6.1.2 (prereg dated notes 26)",
             f"accuracy {acc(every):5.2f}  n={len(every)}  all rows",
             f"accuracy {acc(primary):5.2f}  n={len(primary)}  primary",
             f"answers that say NO ANSWER: {none}", *band_line(arm, acc(every))]
    lines += exhausted_lines(answers, "answers") + exhausted_lines(got, "verdicts")
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
