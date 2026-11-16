"""PersonaMem v1 as MemOS's evaluation suite runs it, over hippo's registered retrievals (prereg dated notes 23, lane P).

MemTensor/MemOS 3a16e5fe evaluation/scripts/personamem: the top 20 memories joined by newlines in MEMOS_CONTEXT_TEMPLATE
(pm_search.py:82-92), PM_ANSWER_PROMPT as one system message to gpt-4o-mini at temperature 0 (pm_responses.py:51-63),
three runs per question, each parsed by extract_choice_answer, scored as the mean over runs of each run's accuracy
(pm_metric.py:180-182). No competitor arm runs (Keith, 13 Nov).
Usage (runner venv): python -I personamem_memos.py {run,score} --arm {hippo-emb,bm25,hippo365} [--limit N] [--slots 8]
"""
from __future__ import annotations

import argparse
import json
import statistics as st
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]
from qa.harness import pred_path, sha_bytes  # noqa: E402
from qa.ledger import Item, Ledger, Manifest, exhausted_lines, one_writer, require, smoke_excluded, unsettled  # noqa: E402
from qa.loaders import personamem_v1 as pm  # noqa: E402
from qa.loaders.personamem_v1 import extract_answer  # noqa: E402  (the same parse as MemOS's extract_choice_answer)
from qa.memos_pm_prompts import MEMOS_CONTEXT_TEMPLATE, PM_ANSWER_PROMPT  # noqa: E402
from qa.openai_llm import EFFORT, OpenAIChat, Settings  # noqa: E402

R2 = Path.home() / "hippo-bench" / "results-r2"
RETRIEVED = {"hippo-emb": R2 / "personamem_v1-emb", "bm25": R2 / "personamem_v1", "hippo365": R2 / "personamem_v1"}
OUT = R2 / "personamem-memos"
RUNS = 3  # pm_responses.py:207, num_runs default
ANSWERER = Settings("gpt-4o-mini-2024-07-18", role="system")
MANIFEST = Manifest(ANSWERER.model, EFFORT, ANSWERER.cli)


def memories(arm: str, qid: str) -> list[str]:
    """The registered retrieval's memory texts in rank order; stops on a file the manifest did not hash."""
    run = RETRIEVED[arm]
    raw = pred_path(run, arm, qid).read_bytes()
    if sha_bytes(raw) != json.loads((run / "predicted" / "manifest.json").read_text(encoding="utf-8"))[arm][qid]:
        sys.exit(f"predicted file for {arm} {qid} differs from its manifest")
    return [r["memory"] for r in json.loads(raw)["results"]]


def prompt(row: int, q: dict, mems: list[str]) -> str:
    context = MEMOS_CONTEXT_TEMPLATE.format(user_id=f"pm_exper_user_{row}_default", memories="\n".join(mems))
    return PM_ANSWER_PROMPT.format(question=q["question"], context=context, options=q["options_raw"])


def items(arm: str, qs: list[tuple[int, dict]]) -> dict[tuple[str, int], Item]:
    out = {}
    for row, q in qs:
        p = prompt(row, q, memories(arm, q["qid"]))
        for r in range(1, RUNS + 1):
            out[(q["qid"], r)] = Item(f"pmmemos answer {arm} {q['qid']} run{r}", "", p, MANIFEST, lambda t: t)
    return out


def run(arm: str, out: Path, qs: list[tuple[int, dict]], slots: int) -> None:
    ledger, llm = Ledger(out / "calls-answer.jsonl"), OpenAIChat(out / "calls-answer.jsonl", ANSWERER, slots=slots)
    require(llm, MANIFEST)
    todo = items(arm, qs)
    print(f"{arm}: {len(qs)} questions x {RUNS} runs into {out}", flush=True)
    with ThreadPoolExecutor(slots) as pool:
        for i, _ in enumerate(pool.map(lambda k: ledger.settle(todo[k], llm), todo), 1):
            if i % 300 == 0:
                print(f"  {i}/{len(todo)}", flush=True)


def accuracy(right: dict[tuple[str, int], bool], qids: list[str]) -> tuple[float, float]:
    """pm_metric.py:180-184: each run's accuracy over the questions, then their mean and population spread."""
    per_run = [100 * sum(right[(q, r)] for q in qids) / len(qids) for r in range(1, RUNS + 1)]
    return st.mean(per_run), st.pstdev(per_run)


def score(arm: str, out: Path, qs: list[tuple[int, dict]]) -> None:
    """An answer exhausted in 3 asks scores wrong, as an empty reply does in MemOS's parse."""
    ledger, todo = Ledger(out / "calls-answer.jsonl"), items(arm, qs)
    got = {k: ledger.choose(item) for k, item in todo.items()}
    unsettled(got, "answers")
    gold = {q["qid"]: q["gold"] for _, q in qs}
    right = {k: c.status == "valid" and extract_answer(c.value, gold[k[0]]) for k, c in got.items()}
    every = [q["qid"] for _, q in qs]
    primary = [q for q in every if q not in smoke_excluded("personamem_v1", [x["qid"] for x in pm.questions()])]
    tokens = [(c.record.get("usage") or {}).get("prompt_tokens") or 0 for c in got.values() if c.record]
    lines = [f"PersonaMem v1 (32k) as MemOS's suite runs it, {arm}: top 20, {ANSWERER.model} answers under "
             f"PM_ANSWER_PROMPT, {RUNS} runs (MemTensor/MemOS 3a16e5fe)"]
    for name, ids in (("all rows", every), ("primary", primary)):
        mean, sd = accuracy(right, ids)
        lines.append(f"accuracy {mean:5.2f}  sd over runs {sd:4.2f}  n={len(ids)}  {name}")
    lines.append(f"mean answer prompt tokens {sum(tokens) / max(1, len(tokens)):.0f}")
    lines += exhausted_lines(got, "answers")
    (out / "score.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("run", "score"))
    ap.add_argument("--arm", choices=tuple(RETRIEVED), required=True)
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--limit", type=int, help="smoke: the first N rows, into OUT/smoke/ARM")
    a = ap.parse_args()
    qs = list(enumerate(pm.questions()))  # the row index is MemOS's conv_idx (pm_search.py main)
    qs = qs[:a.limit] if a.limit else qs
    out = OUT / "smoke" / a.arm if a.limit else OUT / a.arm
    if a.stage == "score":
        score(a.arm, out, qs)
        return
    out.mkdir(parents=True, exist_ok=True)
    with one_writer(out):
        run(a.arm, out, qs, a.slots)


if __name__ == "__main__":
    main()
