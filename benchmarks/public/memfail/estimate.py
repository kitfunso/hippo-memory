"""The full MemFail run's gpt-5-mini tokens, scaled from the smoke's logged calls (notes-2026-11-17-memfail.md).

Each judge check that carries the whole store (storage and summary) is the smoke's prompt with the smoke store swapped
for the full one; the full store is every fact plus a reply of the smoke's mean length. Every check is counted as if all
before it pass, so the total is an upper bound. Persona's batches hold 20 traces (analyze_errors.py DEFAULT_BATCH_SIZE).
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path
from statistics import mean
from types import ModuleType

import vendor as v

STORE_CHECKS = {"storage_check", "summary_check", "fact_storage_check", "fact_summary_check", "storage_check_batch",
                "summary_check_batch"}
PRICE = (0.25, 2.00)  # gpt-5-mini USD per 1M in and out, developers.openai.com/api/docs/models/gpt-5-mini (17 Nov)
SMALL_DAY = 2_500_000
SHUTDOWN = "2026-12-11"  # gpt-5-mini-2025-08-07, developers.openai.com/api/docs/deprecations (read 17 Nov 2026)


def ok_records(path: Path) -> list[dict]:
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    return [r for r in map(json.loads, lines) if r.get("event") == "ok"]


def tok(text: str) -> int:
    import tiktoken
    return len(tiktoken.get_encoding("o200k_base").encode(text, disallowed_special=()))


def store_tokens(facts: list[str], reply_tokens: float) -> float:
    """format_all_memories over the store: "- user: <fact>" and "- assistant: <reply>" lines."""
    return sum(tok(f"- user: {f}") + 1 for f in facts) + len(facts) * (reply_tokens + tok("- assistant: ") + 1)


def main(data: dict, smoke: Path, arm: str, mh: ModuleType) -> None:
    out = smoke / arm
    replies = ok_records(smoke / "calls-reply.jsonl")
    answers = ok_records(out / "calls-answer.jsonl")
    if not replies or not answers:
        raise SystemExit(f"{smoke} holds no settled smoke replies or answers: run the smoke first")
    reply_text = mean(tok(r["text"]) for r in replies)
    reply_out = mean(r["usage"]["completion_tokens"] for r in replies)
    ans_in, ans_out = (mean(r["usage"][k] for r in answers) for k in ("prompt_tokens", "completion_tokens"))
    lines, total_in, total_out = [f"smoke: {len(replies)} replies, mean text {reply_text:.0f} tokens, mean completion "
                                  f"{reply_out:.0f}; {len(answers)} answers, mean {ans_in:.0f} in, {ans_out:.0f} out"], 0, 0
    for task, d in data.items():
        facts = [f for c in d["storage"] for f in c]
        smoke_store = smoke_store_tokens(mh, out, task)
        full_store = store_tokens(facts, reply_text)
        calls = defaultdict(list)
        for f in (out / "judge" / task).glob("*.jsonl"):
            calls[f.stem] = ok_records(f)
        jin = jout = 0.0
        for name, recs in calls.items():
            if not recs:
                continue
            pin, pout = mean(r["usage"]["prompt_tokens"] for r in recs), mean(r["usage"]["completion_tokens"] for r in recs)
            n, per_entry = judge_calls(task, name, d), 20 if task == "persona" else 1
            if name in STORE_CHECKS:
                pin = pin - smoke_store + full_store + (per_entry - 1) * mean(tok(f) for f in facts)
            else:
                pin *= per_entry
            jin, jout = jin + n * pin, jout + n * pout * per_entry
        nf, nq = len(facts), len(d["queries"])
        rin = sum(tok(v.prompt(f, "", [], graded=False)) + 8 for f in facts)
        tin, tout = rin + nq * ans_in + jin, nf * reply_out + nq * ans_out + jout
        total_in, total_out = total_in + tin, total_out + tout
        lines.append(f"{task}: {nf} facts, {nq} questions, store {full_store / 1000:.0f}k tokens (smoke "
                     f"{smoke_store / 1000:.1f}k); replies {(rin + nf * reply_out) / 1e6:.2f}M, answers "
                     f"{nq * (ans_in + ans_out) / 1e6:.2f}M, judge {(jin + jout) / 1e6:.2f}M")
    usd = (total_in * PRICE[0] + total_out * PRICE[1]) / 1e6
    lines.append(f"full run, upper bound: {total_in / 1e6:.1f}M in, {total_out / 1e6:.1f}M out, all in the small free "
                 f"pool: {(total_in + total_out) / SMALL_DAY:.1f} free days of {SMALL_DAY:,}; list price ${usd:.2f}; "
                 f"gpt-5-mini-2025-08-07 shuts down {SHUTDOWN}")
    (smoke / "estimate.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def smoke_store_tokens(mh: ModuleType, out: Path, task: str) -> int:
    """The smoke store as the judges saw it. mh is the running script: a fresh import would lose its smoke flag."""
    turns = dict(mh.conversations())[f"memfail-{task}"]
    return tok(v.module(v.TASKS[task].judge).format_all_memories(mh.all_memories(turns)))


def judge_calls(task: str, name: str, d: dict) -> int:
    """How often the full run makes this call if every earlier check passes."""
    if task == "persona":
        return math.ceil(len(d["queries"]) / 20)
    if task in ("coexisting", "long-hop"):
        field = "preference_facts" if task == "coexisting" else "facts"
        return len(d["queries"]) if name == "invocation_check" else sum(len(r[field]) for r in d["rows"])
    return len(d["queries"])
