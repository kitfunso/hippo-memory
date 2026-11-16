"""EverMemBench lane E's open answers judged again by gpt-4o (prereg dated notes 27, lane E2): how far the score moves with the judge.

The paper names no judge and the repository's default, gemini-3-flash-preview, has no credit. The same answers, the
authors' judge prompts and parse, sent as a system and a user message to gpt-4o-2024-08-06 at temperature 0. Multiple
choice keeps its match. Writes score-judge-gpt4o.txt beside lane E's score.txt, with the agreement with the codex judge.
Usage (runner venv): python -I evermembench_judge_openai.py {judge,score} --arm {hippo-emb,bm25,hippo365} [--limit N]
"""
from __future__ import annotations

import argparse
import dataclasses
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evermembench_openai as eo  # noqa: E402  (it puts the harness on the path)
from qa.ledger import Item, Ledger, Manifest, exhausted_lines, one_writer, require, smoke_excluded, unsettled  # noqa: E402
from qa.loaders import evermembench as ev  # noqa: E402
from qa.openai_llm import EFFORT, OpenAIChat, Settings  # noqa: E402

JUDGE4O = Settings("gpt-4o-2024-08-06")
MANIFEST = Manifest(JUDGE4O.model, EFFORT, JUDGE4O.cli)
LOG = "calls-judge-gpt4o.jsonl"


def as_gpt4o(item: Item) -> Item:
    """The same prompts and parse; only the tag and the manifest change, so the ledger keeps the two judges apart."""
    return dataclasses.replace(item, tag=item.tag.replace("gpt41mini judge", "gpt4o judge"), manifest=MANIFEST)


def items(arm: str, out: Path, qs: list[dict]) -> tuple[dict, dict, dict]:
    """Lane E's judge items with the gpt-4o manifest and tag, the settled multiple choice, and the codex items."""
    codex, settled = eo.judge_items(arm, qs, eo.answers_of(arm, out, qs))
    return {q: as_gpt4o(i) for q, i in codex.items()}, settled, codex


def stage_judge(arm: str, out: Path, qs: list[dict], slots: int) -> None:
    mine, _, _ = items(arm, out, qs)
    ledger, llm = Ledger(out / LOG), OpenAIChat(out / LOG, JUDGE4O, slots=slots)
    require(llm, MANIFEST)
    print(f"{arm}: {len(mine)} open-ended verdicts by gpt-4o", flush=True)
    with ThreadPoolExecutor(slots) as pool:
        list(pool.map(lambda q: ledger.settle(mine[q], llm), mine))


def stage_score(arm: str, out: Path, qs: list[dict]) -> None:
    mine, settled, codex = items(arm, out, qs)
    got = {q: Ledger(out / LOG).choose(i) for q, i in mine.items()}
    was = {q: Ledger(out / "calls-judge.jsonl").choose(i) for q, i in codex.items()}
    unsettled(got, "verdicts")
    unsettled(was, "codex verdicts")
    right = settled | {q: c.status == "valid" and bool(c.value) for q, c in got.items()}
    old = settled | {q: c.status == "valid" and bool(c.value) for q, c in was.items()}
    cats = {q["qid"]: q["category"] for q in qs}
    smoke = smoke_excluded("evermembench", [q["qid"] for q in ev.questions()])
    primary = [q["qid"] for q in qs if q["qid"] not in smoke]
    agree = sum(right[q] == old[q] for q in mine)
    lines = [f"EverMemBench-Dynamic, {arm}: lane E's {eo.ANSWERER.model} answers, open-ended judged again by "
             f"{JUDGE4O.model} with the authors' prompts (prereg dated notes 27)",
             f"Table 4 Average over {len(set(cats.values()))} categories, all {len(qs)} items: "
             f"gpt-4o judge {eo.category_mean(right, cats):5.2f}  codex judge {eo.category_mean(old, cats):5.2f}",
             f"pooled accuracy {100 * sum(right[q] for q in primary) / len(primary):5.2f}  n={len(primary)} primary",
             f"open-ended verdicts that agree with codex: {agree}/{len(mine)} ({100 * agree / max(1, len(mine)):.1f}%)"]
    lines += exhausted_lines(got, "verdicts")
    (out / "score-judge-gpt4o.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("judge", "score"))
    ap.add_argument("--arm", choices=tuple(eo.RETRIEVED), required=True)
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--limit", type=int, help="smoke: lane E's smoke folder, its first N questions")
    a = ap.parse_args()
    qs = ev.questions()[:a.limit] if a.limit else ev.questions()
    out = eo.OUT / "smoke" / a.arm if a.limit else eo.OUT / a.arm
    if a.stage == "score":
        stage_score(a.arm, out, qs)
        return
    with one_writer(out):
        stage_judge(a.arm, out, qs, a.slots)


if __name__ == "__main__":
    main()
