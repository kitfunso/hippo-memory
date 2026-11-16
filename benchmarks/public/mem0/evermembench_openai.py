"""EverMemBench-Dynamic with the paper's answer model, over hippo's registered retrievals (prereg dated notes 24, lane E).

EverMind-AI/EverMemBench e10b3d5: each registered answer prompt (the loader's, with the manifest check of
qa/harness.prompts_of) as one user message to gpt-4.1-mini at temperature 0, max_tokens 1000 (eval/config/pipeline.yaml,
answerer.py:328-335). Multiple choice scores by the authors' parse; open-ended answers go to the registered codex judge
with the authors' prompts. Score: the paper's Table 4 Average over 9 categories, and the pooled primary accuracy.
Usage (runner venv): python -I evermembench_openai.py {answer,judge,score} --arm {hippo-emb,bm25,hippo365} [--limit N]
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
from qa.loaders import evermembench as ev  # noqa: E402
from qa.openai_llm import EFFORT, OpenAIChat, Settings  # noqa: E402

R2 = Path.home() / "hippo-bench" / "results-r2"
RETRIEVED = {"hippo-emb": R2 / "evermembench-emb", "bm25": R2 / "evermembench", "hippo365": R2 / "evermembench"}
OUT = R2 / "evermembench-gpt41mini"
ANSWERER = Settings("gpt-4.1-mini-2025-04-14", max_tokens=1000)
MANIFEST = Manifest(ANSWERER.model, EFFORT, ANSWERER.cli)


def answer_items(arm: str, qs: list[dict]) -> dict[str, Item]:
    prompts = harness.prompts_of(argparse.Namespace(out=RETRIEVED[arm], arms=[arm]), ev, qs)
    return {qid: Item(f"gpt41mini answer {arm} {qid}", p[2], p[3], MANIFEST, lambda t: t)
            for (_, qid), p in prompts.items()}


def answers_of(arm: str, out: Path, qs: list[dict]) -> dict:
    ledger, items = Ledger(out / "calls-answer.jsonl"), answer_items(arm, qs)
    got = {qid: ledger.choose(item) for qid, item in items.items()}
    unsettled(got, "answers")
    return got


def judge_items(arm: str, qs: list[dict], answers: dict) -> tuple[dict[str, Item], dict[str, bool]]:
    """Open-ended answers as judge items; multiple choice and exhausted answers settled here (exhausted scores wrong)."""
    llm, settled = {}, {}
    for q in qs:
        c = answers[q["qid"]]
        if c.status != "valid":
            settled[q["qid"]] = False
            continue
        j = ev.judge(q, c.value)
        if j[0] == "match":
            settled[q["qid"]] = bool(j[1])
        else:
            llm[q["qid"]] = Item(f"gpt41mini judge {arm} {q['qid']}", j[1], j[2], JUDGE, j[3])
    return llm, settled


def stage_answer(arm: str, out: Path, qs: list[dict], slots: int) -> None:
    ledger, items = Ledger(out / "calls-answer.jsonl"), answer_items(arm, qs)
    llm = OpenAIChat(out / "calls-answer.jsonl", ANSWERER, slots=slots)
    require(llm, MANIFEST)
    print(f"{arm}: {len(items)} answers into {out}", flush=True)
    with ThreadPoolExecutor(slots) as pool:
        for i, _ in enumerate(pool.map(lambda q: ledger.settle(items[q], llm), items), 1):
            if i % 400 == 0:
                print(f"  {i}/{len(items)}", flush=True)


def stage_judge(arm: str, out: Path, qs: list[dict], slots: int) -> None:
    from codex_judge import CodexJudge  # noqa: E402
    items, _ = judge_items(arm, qs, answers_of(arm, out, qs))
    ledger, judge = Ledger(out / "calls-judge.jsonl"), CodexJudge(out / "calls-judge.jsonl", slots)
    require(judge, JUDGE)
    print(f"{arm}: {len(items)} open-ended verdicts", flush=True)
    with ThreadPoolExecutor(slots) as pool:
        list(pool.map(lambda q: ledger.settle(items[q], judge), items))


def category_mean(right: dict[str, bool], cats: dict[str, str]) -> float:
    """dated notes 19: the plain mean of each category's accuracy over all its items, as the paper's Table 4 Average."""
    by: dict[str, list[bool]] = {}
    for qid, ok in right.items():
        by.setdefault(cats[qid], []).append(ok)
    return 100 * sum(sum(v) / len(v) for v in by.values()) / len(by)


def stage_score(arm: str, out: Path, qs: list[dict]) -> None:
    answers = answers_of(arm, out, qs)
    items, right = judge_items(arm, qs, answers)
    got = {qid: Ledger(out / "calls-judge.jsonl").choose(item) for qid, item in items.items()}
    unsettled(got, "verdicts")
    right |= {qid: c.status == "valid" and bool(c.value) for qid, c in got.items()}
    cats = {q["qid"]: q["category"] for q in qs}
    smoke = smoke_excluded("evermembench", [q["qid"] for q in ev.questions()])
    primary = [q["qid"] for q in qs if q["qid"] not in smoke]
    lines = [f"EverMemBench-Dynamic with the paper's answer model, {arm}: top {ev.TOPK}, {ANSWERER.model} answers, "
             f"open-ended judged by {JUDGE.model} (EverMind-AI/EverMemBench e10b3d5)",
             f"Table 4 Average over {len(set(cats.values()))} categories, all {len(qs)} items: {category_mean(right, cats):5.2f}",
             f"pooled accuracy {100 * sum(right[q] for q in primary) / len(primary):5.2f}  n={len(primary)} primary",
             *(f"  {c:>8}  {100 * sum(right[q] for q in right if cats[q] == c) / sum(cats[q] == c for q in right):5.1f}"
               for c in sorted(set(cats.values())))]
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
    qs = ev.questions()[:a.limit] if a.limit else ev.questions()
    out = OUT / "smoke" / a.arm if a.limit else OUT / a.arm
    if a.stage == "score":
        stage_score(a.arm, out, qs)
        return
    out.mkdir(parents=True, exist_ok=True)
    with one_writer(out):
        (stage_answer if a.stage == "answer" else stage_judge)(a.arm, out, qs, a.slots)


if __name__ == "__main__":
    main()
