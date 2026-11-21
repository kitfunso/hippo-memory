"""IMLogic Table 5, conversation level, multiple choice: GPT-5.1 answers over hippo's top-30 retrievals, scored by the
authors' exact option match (arXiv 2606.23283; github ThisIsCosine/IMLogic eval/evaluate_common.py at 8823defc18ec).

call_llm_text (evaluate_common.py:230-248) sends the system message and the prompt as one user message with the model
and temperature only (0.0 by default, lines 146-151): no max_tokens, no reasoning_effort. The prompt and the option
shuffle are the loader's (qa/loaders/imlogic.py), the authors' text. The first reply text counts, as the authors ask
once; qa/openai_llm.py retries a transport error instead of scoring it. Score as evaluate_common.py:553-560: the reply's
option letter must name the gold option; no valid letter, or an answer exhausted in the call log, scores wrong in n.
gpt-5.1 is in no free-token pool, so the answer stage bills and runs only with OPENAI_BILLED_MODELS naming the model.
Usage (runner venv): python -I imlogic_openai.py {answer,score} --arm hippo-emb [--limit N] [--run DIR] [--dry-run FILE]
"""
from __future__ import annotations

import argparse
import importlib
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent), str(HERE.parent / "qa")]
from qa import harness  # noqa: E402
from qa.ledger import (Item, Ledger, Manifest, exhausted_lines, one_writer, require, smoke_excluded,  # noqa: E402
                       unsettled)
from qa.openai_llm import EFFORT, OpenAIChat, Settings, cost  # noqa: E402

R2 = Path.home() / "hippo-bench" / "results-r2"
ARMS = {"hippo-emb": R2 / "imlogic-emb"}  # arm -> the harness run that holds its retrievals
# The one snapshot behind "gpt-5.1" (its model page, read 20 Nov 2026): the ledger checks the model a reply names
GPT51 = Settings("gpt-5.1-2025-11-13", temperature=0.0)
MANIFEST = Manifest(GPT51.model, EFFORT, GPT51.cli)


def loader():
    return importlib.import_module("qa.loaders.imlogic")


def run_questions(mod, run: Path, limit: int | None) -> list[dict]:
    """The run's questions in its order (the harness's questions.json); the first N for a smoke."""
    by_id = {q["qid"]: q for q in mod.questions()}
    qs = [by_id[i] for i in json.loads((run / "questions.json").read_text(encoding="utf-8"))["qids"]]
    return qs[:limit] if limit else qs


def check_counts(mod, arm: str, run: Path, qs: list[dict]) -> None:
    """The prompt's Available Memory Count is the loader's; stop unless each user's ingest took that many adds."""
    recs = [json.loads(x) for x in (run / "ingest" / arm / "done.jsonl").read_text(encoding="utf-8").splitlines() if x]
    took = {r["user"]: r["stored"] for r in recs if r["phase"] in ("ingest", "sweep")}
    for user, i in {q["user_id"]: q["user_index"] for q in qs}.items():
        if took.get(user) != mod.memory_count(i):
            sys.exit(f"{user}: {run} records {took.get(user)} memories stored, the prompt would say "
                     f"{mod.memory_count(i)}")


def answer_items(mod, arm: str, run: Path, qs: list[dict]) -> dict[str, Item]:
    check_counts(mod, arm, run, qs)
    prompts = harness.prompts_of(argparse.Namespace(out=run, arms=[arm]), mod, qs)
    return {qid: Item(f"imlogic gpt51 answer {arm} {qid}", p[2], p[3], MANIFEST, lambda t: t)
            for (_, qid), p in prompts.items()}


def answers_of(mod, arm: str, run: Path, out: Path, qs: list[dict]) -> dict:
    ledger, items = Ledger(out / "calls-answer.jsonl"), answer_items(mod, arm, run, qs)
    got = {qid: ledger.choose(item) for qid, item in items.items()}
    unsettled(got, "answers")
    return got


def dry_run(mod, arm: str, run: Path, qs: list[dict], path: Path) -> None:
    """Each prompt as the answer stage would send it, with its letters and the gold letter; no client, nothing sent."""
    items, parts = answer_items(mod, arm, run, qs), []
    for q in qs:
        _, letters = mod.lettered_options(q)
        key = " ".join(f"{c}={o['option_key']}" for c, o in letters.items())
        right = next(c for c, o in letters.items() if o["option_text"] == q["gold"])
        it = items[q["qid"]]
        parts.append(f"=== {q['qid']}  {key}  gold {right}  model {GPT51.model} temperature {GPT51.temperature} ===\n"
                     f"[system]\n{it.system}\n[user]\n{it.user}\n")
    path.write_text("\n".join(parts), encoding="utf-8")
    print(f"wrote {len(parts)} prompts to {path}; nothing was sent")


def stage_answer(mod, arm: str, run: Path, out: Path, qs: list[dict], slots: int) -> None:
    items, log = answer_items(mod, arm, run, qs), out / "calls-answer.jsonl"
    ledger, llm = Ledger(log), OpenAIChat(log, GPT51, slots=slots)
    require(llm, MANIFEST)
    print(f"{arm}: {len(items)} answer calls into {out}", flush=True)
    with ThreadPoolExecutor(slots) as pool:
        for i, _ in enumerate(pool.map(lambda q: ledger.settle(items[q], llm), items), 1):
            if i % 500 == 0:
                print(f"  {i}/{len(items)}", flush=True)


def accuracy(right: dict[str, bool], ids: list[str]) -> float:
    """Correct over every item asked, as build_summary's accuracy_all (evaluate_common.py:616)."""
    return 100 * sum(right[i] for i in ids) / len(ids)


def stage_score(mod, arm: str, run: Path, out: Path, qs: list[dict], smoke: bool) -> None:
    got = answers_of(mod, arm, run, out, qs)
    valid = {qid: c.value for qid, c in got.items() if c.status == "valid"}
    right = {q["qid"]: q["qid"] in valid and mod.is_correct(q, valid[q["qid"]]) for q in qs}
    no_letter = sum(mod.choice_letter(valid[q["qid"]], set(mod.lettered_options(q)[1])) is None
                    for q in qs if q["qid"] in valid)
    every = [q["qid"] for q in qs]
    if smoke:
        primary, note = every, "SMOKE run: never scored or reused"
    else:
        left = smoke_excluded("imlogic", [q["qid"] for q in mod.questions()])
        primary = [i for i in every if i not in left]
        note = f"smoke items left out of the primary: {', '.join(sorted(left)) or 'none'}"
    usage = [c.record.get("usage") or {} for c in got.values() if c.status == "valid"]
    tokens = {k: sum(u.get(k) or 0 for u in usage) for k in ("prompt_tokens", "completion_tokens")}
    reasoning = sum((u.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0 for u in usage)
    lines = [f"{mod.NAME}, {arm}: top {mod.TOPK}, {GPT51.model} answers at temperature 0, no max_tokens, no "
             f"reasoning_effort, the authors' prompt and seed-{mod.SHUFFLE_SEED} option shuffle (ThisIsCosine/IMLogic "
             f"{mod.REPO_SHA[:12]}, data {mod.DATA_DIGEST[:12]}; arXiv 2606.23283 Table 5)",
             f"accuracy {accuracy(right, every):5.2f}  n={len(every)}  all items",
             f"accuracy {accuracy(right, primary):5.2f}  n={len(primary)}  primary",
             f"replies with no valid option letter, scored wrong: {no_letter}",
             f"answer tokens: prompt {tokens['prompt_tokens']}, completion {tokens['completion_tokens']} (reasoning "
             f"{reasoning}) over {len(usage)} replies, {cost(GPT51.model, tokens):.2f} USD at list price",
             *exhausted_lines(got, "answers"), "", note]
    (out / "score.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("answer", "score"))
    ap.add_argument("--arm", choices=tuple(ARMS), required=True)
    ap.add_argument("--run", type=Path, help="the harness run with the retrievals (default: the arm's results-r2 run)")
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--limit", type=int, help="smoke: the run's first N questions, into RUN/smoke/gpt51")
    ap.add_argument("--dry-run", type=Path, metavar="FILE", help="answer: write the prompts to FILE and send nothing")
    a = ap.parse_args()
    if a.dry_run and a.stage != "answer":
        ap.error("--dry-run goes with the answer stage")
    mod, run = loader(), a.run or ARMS[a.arm]
    qs = run_questions(mod, run, a.limit)
    out = run / "smoke" / "gpt51" if a.limit else run / "gpt51"
    if a.dry_run:
        dry_run(mod, a.arm, run, qs, a.dry_run)
    elif a.stage == "score":
        stage_score(mod, a.arm, run, out, qs, bool(a.limit))
    else:
        out.mkdir(parents=True, exist_ok=True)
        with one_writer(out):
            stage_answer(mod, a.arm, run, out, qs, a.slots)


if __name__ == "__main__":
    main()
