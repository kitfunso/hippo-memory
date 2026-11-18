"""The full InMind run's gpt-5-mini tokens, from the smoke (notes-2026-11-17-inmind.md).

Prompts are counted exactly (o200k) for all 5 smoke tasks' retrievals, plus the per-call overhead the asked task's
logged prompt_tokens show; outputs are the asked task's logged completions. A judge prompt that carries an answer is
counted with the asked task's mean answer text. The mean task, times 125.
"""
from __future__ import annotations

import json
from pathlib import Path
from statistics import mean

from inmind import vendor as v

PRICE = (0.25, 2.00)  # gpt-5-mini USD per 1M in and out, developers.openai.com/api/docs/pricing (17 Nov)
SMALL_DAY = 2_500_000
SHUTDOWN = "2026-12-11"  # gpt-5-mini-2025-08-07, developers.openai.com/api/docs/deprecations (read 17 Nov 2026)


def tok(text: str) -> int:
    import tiktoken
    return len(tiktoken.get_encoding("o200k_base").encode(text, disallowed_special=()))


def ok_records(path: Path) -> list[dict]:
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    return [r for r in map(json.loads, lines) if r.get("event") == "ok"]


def main(out: Path, arm: str) -> None:
    from inmind import inmind_hippo as ih
    ih.Run.smoke = True
    qs = ih.questions()
    answers, judges = ok_records(out / "calls-answer.jsonl"), ok_records(out / "calls-judge.jsonl")
    if not answers or len(judges) < 3:
        raise SystemExit(f"{out} holds no settled smoke answers and verdicts: run the smoke first")
    asked = ih.asked(qs)
    items = ih.answer_items(out, arm, asked)
    by_user = {(r["tag"], r["user"]): r for r in answers}
    framing = mean(by_user[it.key]["usage"]["prompt_tokens"] - tok(it.system) - tok(it.user) for it in items.values())
    a_out = mean(r["usage"]["completion_tokens"] for r in answers)
    rows = ih.results(out, arm, asked)
    a_text = mean(tok(t["answer"]) for row in rows.values() for t in row.values())
    j_out = {m: mean(r["usage"]["completion_tokens"] for r in judges if r["tag"].startswith(f"im judge {m} "))
             for m in v.METRICS}
    by_id, per_task = {t["task_id"]: t for t in v.tasks()}, []
    for tid in sorted({q["task_id"] for q in qs}):
        ctx = {q["kind"]: v.context(ih.memories(out, arm, q["qid"])) for q in qs if q["task_id"] == tid}
        task = by_id[tid]
        a_in = sum(tok(v.answer_system(ctx[k])) + tok(task[f]) + framing
                   for k, f in (("naive", "naive_query"), ("query", "query")))
        empty = {k: {"context": c, "answer": ""} for k, c in ctx.items()}
        j_in = sum(tok(v.judge_system(m)) + tok(v.judge_user(m, task, empty)) + framing
                   + (a_text if m != "target-recall" else 0) for m in v.METRICS)
        per_task.append((a_in, j_in, sum(tok(c) for c in ctx.values()) / 2))
    n = len(v.tasks())
    tin = n * mean(a + j for a, j, _ in per_task)
    tout = n * (2 * a_out + sum(j_out.values()))
    usd = (tin * PRICE[0] + tout * PRICE[1]) / 1e6
    lines = [f"smoke: {len(answers)} answers, mean {a_out:.0f} completion tokens ({a_text:.0f} visible); judges "
             + ", ".join(f"{m} {o:.0f}" for m, o in j_out.items()) + f" completion tokens; framing {framing:.0f} per call",
             f"retrieved context over {len(per_task)} smoke tasks: mean {mean(c for *_, c in per_task):.0f} tokens per "
             f"query; per task {mean(a for a, _, _ in per_task):.0f} answer and {mean(j for _, j, _ in per_task):.0f} "
             f"judge input tokens",
             f"full run, {n} tasks x 5 calls: {tin / 1e6:.2f}M in, {tout / 1e6:.2f}M out, {(tin + tout) / 1e6:.2f}M "
             f"tokens, {(tin + tout) / SMALL_DAY:.2f} days of the whole small free pool ({SMALL_DAY:,} a day); list "
             f"price ${usd:.2f}; gpt-5-mini-2025-08-07 shuts down {SHUTDOWN}"]
    (out.parent / "estimate.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
