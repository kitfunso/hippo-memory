#!/usr/bin/env python3
"""LongMemEval-S retrieval of `hippo recall` as a user runs it: one CLI-built store per question.

Method, arms and gates: docs/evals/2026-09-28-recall-cli-longmemeval-prereg.md.
The JSONL rows are what evaluate_retrieval.py and score_haystack.py read, unchanged.

  python recall_cli_haystack.py build  --hippo <install A>/node_modules/hippo-memory/bin/hippo.js --data D --work W
  python recall_cli_haystack.py embed  --hippo <install B>/node_modules/hippo-memory/bin/hippo.js --data D --work W
  python recall_cli_haystack.py recall --hippo <install>/... --data D --work W --store stores|embedded --run NAME
         [--budget N] [--shuffle] [--why]
  python recall_cli_haystack.py stats  --data D --work W --runs NAME ... --pairs B:A ... --out stats.json
Every command takes --limit N (first N questions) and --workers N.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import shutil
import statistics
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from math import comb
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("recall_cli_haystack")
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
NODE = shutil.which("node") or "node"
# Only what node needs to start; every HIPPO_*, XDG_*, API-key and agent variable stays out.
PASS_ENV = {"PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG"}
REMEMBERED = re.compile(r"^Remembered \[([^\]]+)\]", re.M)
EMBED_STATUS = re.compile(r"Embedding status: (\d+)/(\d+) memories embedded")
TOP_KEEP = 10  # evaluate_retrieval.py reads at most the top 10


def hippo(bin_path: str, inst: Path, args: list[str], stdin: str | None = None) -> str:
    """Run the CLI with cwd, HIPPO_HOME, HOME and USERPROFILE all inside `inst`."""
    home = str(inst / "home")
    env = {k: v for k, v in os.environ.items() if k.upper() in PASS_ENV}
    env.update(HIPPO_HOME=str(inst / "global"), HOME=home, USERPROFILE=home)
    proc = subprocess.run(
        [NODE, bin_path, *args], cwd=inst / "work", env=env, input=stdin,
        stdin=None if stdin is not None else subprocess.DEVNULL,
        capture_output=True, text=True, encoding="utf-8", timeout=900,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"hippo {args[0]} exited {proc.returncode}: {proc.stderr.strip()[:400]}")
    return proc.stdout


def when(stamp: str) -> datetime:
    day, _weekday, clock = stamp.split(" ")  # "2023/05/20 (Sat) 02:21"
    return datetime.strptime(f"{day} {clock}", "%Y/%m/%d %H:%M")


def build_one(q: dict[str, Any], work: Path, bin_path: str) -> None:
    inst = work / "stores" / q["question_id"]
    done = inst / "ids.json"
    if done.exists():
        return
    if inst.exists():
        shutil.rmtree(inst)
    for sub in ("work", "global", "home"):
        (inst / sub).mkdir(parents=True)
    start = time.perf_counter()
    out = hippo(bin_path, inst, ["init", "--no-hooks", "--no-schedule", "--no-learn"])
    if f"Initialized Hippo at {inst / 'work' / '.hippo'}" not in out:
        raise RuntimeError(f"{q['question_id']}: store did not land in its own dir: {out.strip()[:300]}")
    sids = q["haystack_session_ids"]
    order = sorted(range(len(sids)), key=lambda i: (when(q["haystack_dates"][i]), i))
    ids: dict[str, str] = {}
    for i in order:
        text = "\n".join(turn["content"] for turn in q["haystack_sessions"][i])
        match = REMEMBERED.search(hippo(bin_path, inst, ["remember", "-"], stdin=text))
        if not match or match.group(1) in ids:
            raise RuntimeError(f"{q['question_id']}: no new memory id for session {sids[i]}")
        ids[match.group(1)] = sids[i]
    record = {"ids": ids, "seconds": round(time.perf_counter() - start, 3), "sessions": len(sids)}
    done.with_suffix(".tmp").write_text(json.dumps(record), encoding="utf-8")
    done.with_suffix(".tmp").replace(done)


def embed_one(q: dict[str, Any], work: Path, bin_path: str) -> None:
    src, inst = work / "stores" / q["question_id"], work / "embedded" / q["question_id"]
    done = inst / "embed.json"
    if done.exists():
        return
    if inst.exists():
        shutil.rmtree(inst)
    shutil.copytree(src, inst)
    start = time.perf_counter()
    hippo(bin_path, inst, ["embed"])
    seconds = round(time.perf_counter() - start, 3)
    status = EMBED_STATUS.search(hippo(bin_path, inst, ["embed", "--status"]))
    n = len(q["haystack_session_ids"])
    if not status or int(status.group(1)) != n or int(status.group(2)) != n:
        raise RuntimeError(f"{q['question_id']}: embedding coverage is not {n}/{n}: {status and status.group(0)}")
    done.write_text(json.dumps({"seconds": seconds, "status": status.group(0)}), encoding="utf-8")


def recall_one(q: dict[str, Any], query: str, work: Path, bin_path: str, store: str, run: str,
               flags: list[str]) -> dict[str, Any]:
    # A fresh copy per call: recall strengthens what it returns and writes traces.
    src, inst = work / store / q["question_id"], work / "runs" / run / q["question_id"]
    if inst.exists():
        shutil.rmtree(inst)
    shutil.copytree(src, inst)
    ids = json.loads((src / "ids.json").read_text(encoding="utf-8"))["ids"]
    start = time.perf_counter()
    out = json.loads(hippo(bin_path, inst, ["recall", query, "--json", *flags]))
    seconds = round(time.perf_counter() - start, 3)
    shutil.rmtree(inst)
    ranked = [
        {"id": r["id"], "score": r["score"], "tokens": r["tokens"], "tags": [ids[r["id"]]],
         "content": r["content"], **({"cosine": r.get("cosine"), "bm25": r.get("bm25")} if "--why" in flags else {})}
        for r in out["results"]
    ]
    return {
        "question_id": q["question_id"], "question": q["question"], "query": query, "answer": q["answer"],
        "question_type": q["question_type"], "question_date": q["question_date"],
        "retrieved_memories": ranked[:TOP_KEEP], "num_retrieved": len(ranked),
        "returned_tokens": sum(r["tokens"] for r in ranked), "budget": out.get("budget"),
        "suppression": out.get("suppressionSummary"), "seconds": seconds,
    }


def fan_out(fn: Callable[[Any], Any], items: list[Any], workers: int, label: str) -> list[Any]:
    results: list[Any] = [None] * len(items)
    start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fn, item): i for i, item in enumerate(items)}
        for n, fut in enumerate(futures, 1):
            results[futures[fut]] = fut.result()
            if n % 20 == 0 or n == len(items):
                log.info("%s %d/%d  %.0fs", label, n, len(items), time.perf_counter() - start)
    log.info("%s wall %.1fs with %d workers", label, time.perf_counter() - start, workers)
    return results


def cmd_recall(args: argparse.Namespace, qs: list[dict[str, Any]]) -> None:
    half = len(qs) // 2
    flags = (["--budget", str(args.budget)] if args.budget is not None else []) + (["--why"] if args.why else [])
    # Shuffle pairs each haystack with the question half the set away: a noise-only query.
    jobs = [(q, qs[(i + half) % len(qs)]["question"] if args.shuffle else q["question"]) for i, q in enumerate(qs)]
    rows = fan_out(lambda job: recall_one(job[0], job[1], args.work, args.hippo, args.store, args.run, flags),
                   jobs, args.workers, f"recall {args.run}")
    out = args.work / f"{args.run}.jsonl"
    out.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    log.info("wrote %s", out)


def load_rows(path: Path) -> dict[str, dict[str, Any]]:
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return {r["question_id"]: r for r in rows}


def bootstrap(vectors: dict[str, list[float]]) -> dict[str, Any]:
    """Percentile bootstrap from src/eval-stats.ts (dist build), B=10000, seed 1."""
    url = (REPO / "dist" / "eval-stats.js").resolve().as_uri()
    script = (
        "const { pairedBootstrap } = await import(process.argv[1]);"
        "const v = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
        "const out = {}; for (const [k, d] of Object.entries(v)) out[k] = pairedBootstrap(d, { iterations: 10000, seed: 1 });"
        "process.stdout.write(JSON.stringify(out));"
    )
    wrapped = "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" + script
    proc = subprocess.run([NODE, "--input-type=module", "-e", wrapped, url], input=json.dumps(vectors),
                          capture_output=True, text=True, encoding="utf-8", check=True)
    return json.loads(proc.stdout)


def chance_r5(q: dict[str, Any]) -> float:
    """Chance that 5 memories drawn at random from this haystack include an answer session."""
    n = len(q["haystack_session_ids"])
    a = sum(sid in q["answer_session_ids"] for sid in q["haystack_session_ids"])
    return 1 - comb(n - a, 5) / comb(n, 5)


def run_summary(rows: dict[str, dict[str, Any]], qs: list[dict[str, Any]], hit: list[float]) -> dict[str, Any]:
    per_type: dict[str, list[float]] = {}
    for q, h in zip(qs, hit):
        per_type.setdefault(q["question_type"], []).append(h)
    picked = [rows[q["question_id"]] for q in qs]
    returned = [r["num_retrieved"] for r in picked]
    sup = [r["suppression"] or {} for r in picked]
    secs = sorted(r["seconds"] for r in picked)
    return {
        "per_type": {t: {"n": len(v), "r5": round(100 * sum(v) / len(v), 1)} for t, v in sorted(per_type.items())},
        "returned_median": statistics.median(returned),
        "returned_under_5": sum(n < 5 for n in returned),
        "returned_tokens_median": statistics.median(r["returned_tokens"] for r in picked),
        "candidates_median": statistics.median(s.get("totalCandidates", 0) for s in sup),
        "questions_with_budget_drops": sum(s.get("droppedByBudget", 0) > 0 for s in sup),
        "dropped_pre_rank_total": sum(s.get("droppedPreRank", 0) for s in sup),
        "recall_seconds_median": statistics.median(secs),
        "recall_seconds_p90": secs[int(0.9 * (len(secs) - 1))],
    }


def cmd_stats(args: argparse.Namespace, qs: list[dict[str, Any]]) -> None:
    sys.path.insert(0, str(HERE))
    from evaluate_retrieval import check_session_hit  # the scorer behind the 98.0, unchanged

    runs = {name: load_rows(args.work / f"{name}.jsonl") for name in args.runs}
    hits = {
        name: [float(check_session_hit(rows[q["question_id"]]["retrieved_memories"], q["answer_session_ids"], 5))
               for q in qs]
        for name, rows in runs.items()
    }
    vectors = dict(hits)
    for pair in args.pairs:
        b, a = pair.split(":")
        vectors[f"{b} - {a}"] = [x - y for x, y in zip(hits[b], hits[a])]
    ci = bootstrap(vectors)
    report: dict[str, Any] = {
        "n": len(qs), "chance_r5": round(statistics.mean(chance_r5(q) for q in qs), 4),
        "bootstrap": "pairedBootstrap (src/eval-stats.ts), 10000 resamples, seed 1, 95% percentile interval",
        "runs": {name: {"r5": ci[name], **run_summary(runs[name], qs, hits[name])} for name in runs},
        "pairs": {},
    }
    for pair in args.pairs:
        b, a = pair.split(":")
        only_b = sum(x > y for x, y in zip(hits[b], hits[a]))
        only_a = sum(y > x for x, y in zip(hits[b], hits[a]))
        report["pairs"][f"{b} - {a}"] = {**ci[f"{b} - {a}"], "hit_only_first": only_b, "hit_only_second": only_a}
    builds = [json.loads((args.work / "stores" / q["question_id"] / "ids.json").read_text(encoding="utf-8"))
              for q in qs]
    report["remember_seconds_median"] = round(statistics.median(b["seconds"] / b["sessions"] for b in builds), 3)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    log.info("wrote %s", args.out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["build", "embed", "recall", "stats"])
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--hippo", help="path to bin/hippo.js of the install under test")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--store", choices=["stores", "embedded"], default="stores")
    parser.add_argument("--run")
    parser.add_argument("--budget", type=int)
    parser.add_argument("--shuffle", action="store_true")
    parser.add_argument("--why", action="store_true", help="adds cosine/bm25 per result; checks only")
    parser.add_argument("--runs", nargs="*", default=[])
    parser.add_argument("--pairs", nargs="*", default=[], help="FIRST:SECOND, reported as FIRST - SECOND")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    qs = json.loads(args.data.read_text(encoding="utf-8"))[: args.limit]
    args.work.mkdir(parents=True, exist_ok=True)
    if args.command == "build":
        fan_out(lambda q: build_one(q, args.work, args.hippo), qs, args.workers, "build")
    elif args.command == "embed":
        fan_out(lambda q: embed_one(q, args.work, args.hippo), qs, args.workers, "embed")
    elif args.command == "recall":
        cmd_recall(args, qs)
    else:
        cmd_stats(args, qs)


if __name__ == "__main__":
    main()
