"""HaluMem question answering with the paper's GPT-4o answers and judge, over hippo's registered retrievals (dated notes 28, lane H).

IAAR-Shanghai/HaluMem eval/: llms.py sends each prompt as one user message to OPENAI_MODEL=gpt-4o at temperature 0.0
with max_tokens 16384 (eval/.env-example lines 3-5, eval/README.md lines 38-40), for the answer (eval_memzero.py
lines 244-250) and for the judge (evaluation.py). The prompts are the loader's, the authors' text verbatim.
Usage (runner venv): python -I halumem_openai.py {answer,judge,score} --variant {medium,long} --arm ARM [--limit N]
"""
from __future__ import annotations

import argparse
import importlib
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent), str(HERE.parent / "qa")]
from qa import harness  # noqa: E402
from qa.ledger import Item, Ledger, Manifest, exhausted_lines, one_writer, require, smoke_excluded, unsettled  # noqa: E402
from qa.openai_llm import EFFORT, OpenAIChat, Settings  # noqa: E402

R2 = Path.home() / "hippo-bench" / "results-r2"
ARMS = {"hippo-emb": "halumem-{v}-emb", "bm25": "halumem-{v}", "hippo365": "halumem-{v}", "hippo-best": "halumem-{v}-best"}
OUT = R2 / "halumem-gpt4o"
GPT4O = Settings("gpt-4o-2024-08-06", temperature=0.0, max_tokens=16384)  # today's snapshot behind the alias "gpt-4o"
MANIFEST = Manifest(GPT4O.model, EFFORT, GPT4O.cli)
LABELS = ("Correct", "Hallucination", "Omission")


def loader(variant: str):
    """The loader reads its variant from the environment when it is imported, so set it first."""
    os.environ["HALUMEM_VARIANT"] = variant
    return importlib.import_module("qa.loaders.halumem")


def answer_items(mod, variant: str, arm: str, qs: list[dict]) -> dict[str, Item]:
    run = R2 / ARMS[arm].format(v=variant)
    prompts = harness.prompts_of(argparse.Namespace(out=run, arms=[arm]), mod, qs)
    return {qid: Item(f"halumem-{variant} gpt4o answer {arm} {qid}", p[2], p[3], MANIFEST, lambda t: t)
            for (_, qid), p in prompts.items()}


def answers_of(mod, variant: str, arm: str, out: Path, qs: list[dict]) -> dict:
    ledger, items = Ledger(out / "calls-answer.jsonl"), answer_items(mod, variant, arm, qs)
    got = {qid: ledger.choose(item) for qid, item in items.items()}
    unsettled(got, "answers")
    return got


def judge_items(mod, variant: str, arm: str, qs: list[dict], answers: dict) -> dict[str, Item]:
    """Every valid answer, the empty one too, as the authors judge every response; an exhausted answer scores wrong."""
    out = {}
    for q in qs:
        c = answers[q["qid"]]
        if c.status == "valid":
            _, system, user, parse = mod.judge(q, c.value)
            out[q["qid"]] = Item(f"halumem-{variant} gpt4o judge {arm} {q['qid']}", system, user, MANIFEST, parse)
    return out


def stage(name: str, mod, variant: str, arm: str, out: Path, qs: list[dict], slots: int) -> None:
    if name == "answer":
        items, log = answer_items(mod, variant, arm, qs), out / "calls-answer.jsonl"
    else:
        items, log = judge_items(mod, variant, arm, qs, answers_of(mod, variant, arm, out, qs)), out / "calls-judge.jsonl"
    ledger, llm = Ledger(log), OpenAIChat(log, GPT4O, slots=slots)
    require(llm, MANIFEST)
    print(f"{variant} {arm}: {len(items)} {name} calls into {out}", flush=True)
    with ThreadPoolExecutor(slots) as pool:
        for i, _ in enumerate(pool.map(lambda q: ledger.settle(items[q], llm), items), 1):
            if i % 500 == 0:
                print(f"  {i}/{len(items)}", flush=True)


def ratios(labels: dict[str, str], ids: list[str]) -> dict[str, float]:
    """evaluation.py correct_qa_ratio(all) and its two siblings: each label over every item, an exhausted one counted."""
    return {lab: 100 * sum(labels[q] == lab for q in ids) / len(ids) for lab in LABELS}


def stage_score(mod, variant: str, arm: str, out: Path, qs: list[dict]) -> None:
    answers = answers_of(mod, variant, arm, out, qs)
    items = judge_items(mod, variant, arm, qs, answers)
    got = {q: Ledger(out / "calls-judge.jsonl").choose(i) for q, i in items.items()}
    unsettled(got, "verdicts")
    labels = {q["qid"]: "Exhausted" for q in qs}
    labels |= {q: mod.label_of(c.record["text"]) for q, c in got.items() if c.status == "valid"}
    smoke = smoke_excluded("halumem", [q["qid"] for q in mod.questions()])
    every, primary = [q["qid"] for q in qs], [q["qid"] for q in qs if q["qid"] not in smoke]
    lines = [f"HaluMem-{variant.title()} question answering, {arm}: top {mod.TOPK}, {GPT4O.model} answers and judge at "
             f"temperature 0 (IAAR-Shanghai/HaluMem eval, prereg dated notes 28)"]
    for name, ids in (("all items", every), ("primary", primary)):
        r = ratios(labels, ids)
        lines.append(f"correct {r['Correct']:5.2f}  hallucination {r['Hallucination']:5.2f}  omission {r['Omission']:5.2f}"
                     f"  n={len(ids)}  {name}")
    lines += exhausted_lines(answers, "answers") + exhausted_lines(got, "verdicts")
    (out / "score.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("answer", "judge", "score"))
    ap.add_argument("--variant", choices=("medium", "long"), required=True)
    ap.add_argument("--arm", choices=tuple(ARMS), required=True)
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--limit", type=int, help="smoke: the first N questions, into OUT/smoke/VARIANT/ARM")
    a = ap.parse_args()
    mod = loader(a.variant)
    qs = mod.questions()[:a.limit] if a.limit else mod.questions()
    out = (OUT / "smoke" if a.limit else OUT) / a.variant / a.arm
    if a.stage == "score":
        stage_score(mod, a.variant, a.arm, out, qs)
        return
    out.mkdir(parents=True, exist_ok=True)
    with one_writer(out):
        stage(a.stage, mod, a.variant, a.arm, out, qs, a.slots)


if __name__ == "__main__":
    main()
