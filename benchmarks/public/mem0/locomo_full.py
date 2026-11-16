"""LoCoMo over all 1,540 category 1 to 4 questions for hippo-emb at top 200 (prereg Amendment 6, dated notes 20).

Published LoCoMo rows use all 1,540 questions; our registered runs use a 400 sample. This answers every question with
h2h's own prompt and item tags, so a run folder seeded with the registered emb run's call log reuses the 400 sample
answers, and judges with the Mem0 paper's prompt as rescore_official.py does (codex gpt-5.6-sol; the paper used
gpt-4o-mini). Usage (runner venv): python -I locomo_full.py {answer,judge,score} --run RUN_DIR --out OUT_DIR [--slots 6]
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent / "runner"), str(HERE.parent / "qa"), str(HERE.parent), str(HERE)]
import codex_judge  # noqa: E402
import h2h  # noqa: E402
from claude_llm import Claude  # noqa: E402
from qa.ledger import (ANSWERER, JUDGE, Item, Ledger, exhausted_lines, one_writer, require, smoke_excluded,  # noqa: E402
                       unsettled)
from qa.official_judges import ACCURACY_PROMPT  # noqa: E402
from rescore_official import PREAMBLE, label_in  # noqa: E402

ARM, CUT = "hippo-emb", 200
LOGS = {"answer": "calls-answer.jsonl", "judge": "calls-judge-official.jsonl"}


def all_qids(data: list) -> list[str]:
    """Every category 1 to 4 question as h2h names it: conversation index and the question's index in its qa list."""
    return [f"conv{c}_q{i}" for c, conv in enumerate(data) for i, qa in enumerate(conv["qa"]) if qa["category"] in (1, 2, 3, 4)]


def answer_items(run: Path, qids: list[str]) -> dict[str, Item]:
    """h2h.answer_prompts' item for each question, so a seeded log's replies count for the same prompts."""
    ns = argparse.Namespace(arms=(ARM,), qids=qids, cutoffs=(CUT,), run=run)
    return {qid: item for (_, _, qid), (_, item) in h2h.answer_prompts(ns).items()}


def judge_item(qa: dict, qid: str, answer: str) -> Item:
    """rescore_official.locomo_items' item for the same answer: same tag, prompt and parse."""
    prompt = ACCURACY_PROMPT.format(question=qa["question"], gold_answer=qa["answer"], generated_answer=answer)
    return Item(f"official {ARM} {CUT} {qid}", "", prompt, JUDGE, label_in)


def settle_all(ledger: Ledger, llm, items: list[Item], slots: int) -> None:
    todo = [it for it in items if ledger.choose(it).status == "open"]
    print(f"{len(items)} items, {len(todo)} to ask", flush=True)
    with ThreadPoolExecutor(slots) as pool:
        for i, _ in enumerate(pool.map(lambda it: ledger.settle(it, llm), todo), 1):
            if i % 100 == 0:
                print(f"  {i}/{len(todo)}", flush=True)


def answers_of(run: Path, qids: list[str]) -> dict[str, object]:
    ledger, items = Ledger(run / LOGS["answer"]), answer_items(run, qids)
    choices = {qid: ledger.choose(it) for qid, it in items.items()}
    unsettled(choices, "answers")
    return choices


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("answer", "judge", "score"))
    ap.add_argument("--run", type=Path, required=True, help="call logs; seed it with the registered emb run's answer log")
    ap.add_argument("--out", type=Path, required=True, help="score.txt and score.json")
    ap.add_argument("--slots", type=int, default=6)
    a = ap.parse_args()
    data = h2h.load(h2h.LOCOMO / "data" / "locomo10.json")
    qids = all_qids(data)
    if a.stage == "answer":
        with one_writer(a.run):
            llm = Claude(a.run / "claude-work", a.run / LOGS["answer"], a.slots)
            require(llm, ANSWERER)
            settle_all(Ledger(a.run / LOGS["answer"]), llm, list(answer_items(a.run, qids).values()), a.slots)
        return
    answers = answers_of(a.run, qids)
    items = {qid: judge_item(h2h.qa_of(data, qid), qid, c.value) for qid, c in answers.items() if c.status == "valid"}
    if a.stage == "judge":
        with one_writer(a.run):
            codex_judge.PREAMBLE = PREAMBLE
            llm = codex_judge.CodexJudge(log=a.run / LOGS["judge"], slots=a.slots)
            require(llm, JUDGE)
            settle_all(Ledger(a.run / LOGS["judge"]), llm, list(items.values()), a.slots)
        return
    score(a, data, qids, answers, items)


def score(a: argparse.Namespace, data: list, qids: list[str], answers: dict, items: dict) -> None:
    """Accuracy over all 1,540, without the smoke items, per category and over the 400 sample, exhausted items as wrong."""
    ledger = Ledger(a.run / LOGS["judge"])
    choices = {qid: ledger.choose(it) for qid, it in items.items()}
    unsettled(choices, "official verdicts")
    ok = {qid: qid in choices and choices[qid].status == "valid" and bool(choices[qid].value) for qid in qids}
    pct = lambda ks: 100 * sum(ok[k] for k in ks) / len(ks)  # noqa: E731
    smoke, sample = smoke_excluded("locomo", qids), set(h2h.load(h2h.SAMPLE))
    groups = {"all": qids, "without the smoke items": [q for q in qids if q not in smoke],
              **{h2h.CAT[c]: [q for q in qids if h2h.qa_of(data, q)["category"] == c] for c in (1, 2, 3, 4)},
              "the 400 sample": [q for q in qids if q in sample]}
    js = {name: {"accuracy": pct(ks), "n": len(ks)} for name, ks in groups.items()}
    lines = [f"LoCoMo, all category 1 to 4 questions, {ARM} at top {CUT}, Claude Sonnet 5 answers; the Mem0 paper's judge "
             f"prompt on codex gpt-5.6-sol (the paper used gpt-4o-mini)"]
    lines += [f"  {name:>24}  {r['accuracy']:5.1f}  n={r['n']}" for name, r in js.items()]
    lines += exhausted_lines({q: c for q, c in answers.items()}, "answers") + exhausted_lines(choices, "official verdicts")
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "score.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (a.out / "score.json").write_text(json.dumps(js, indent=1), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
