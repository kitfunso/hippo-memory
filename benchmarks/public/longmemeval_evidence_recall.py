"""Free retrieval check on Mem0-runner LongMemEval-S output (no model calls).

For each question, the share of its evidence turns (haystack messages with
`has_answer: true`) found in the top k retrieved memories, from
`--predict-only` output of mem0ai/memory-benchmarks. Sibling of
evidence_recall.py (LoCoMo); see docs/evals/2026-09-24-public-benchmarks-prereg.md
Amendment 2. Usage:

    python longmemeval_evidence_recall.py --dataset longmemeval_s_cleaned.json \
        --run-dir out/predicted_<name> [--k 10,50,200] [--baseline out/predicted_<other>]
"""
from __future__ import annotations

import argparse
import glob
import json
import random
from collections import defaultdict


def boot(diffs: list[float], draws: int = 4000) -> tuple[float, float, float]:
    """Paired bootstrap 95% CI for a mean of per-question differences."""
    random.seed(1)
    n = len(diffs)
    means = sorted(sum(random.choice(diffs) for _ in range(n)) / n for _ in range(draws))
    return sum(diffs) / n, means[int(0.025 * draws)], means[int(0.975 * draws) - 1]


def evidence_texts(q: dict) -> list[str]:
    out = []
    for sess in q["haystack_sessions"]:
        for turn in sess:
            if turn.get("has_answer") and turn.get("content"):
                out.append(f'{turn.get("role", "")}: {turn["content"]}')
    return out


def score_run(run_dir: str, evidence: dict, ks: list[int]) -> tuple[dict, dict]:
    """agg[type][metric] -> list of values; per_q[k] -> {question_id: recall}."""
    agg: dict = defaultdict(lambda: defaultdict(list))
    per_q: dict = defaultdict(dict)
    for f in sorted(glob.glob(f"{run_dir}/*.json")):
        if f.split("/")[-1].split("\\")[-1].startswith("_ingestion_"):
            continue  # per-session checkpoint, not a scored question
        q = json.load(open(f, encoding="utf-8"))
        ev = evidence.get(q["question_id"], [])
        if not ev:
            continue
        mems = [r["memory"] for r in q["retrieval"]["search_results"]]
        for k in ks:
            top = "\n".join(mems[:k])
            found = sum(e in top for e in ev)
            recall = found / len(ev)
            per_q[k][q["question_id"]] = recall
            for typ in ("all", q["question_type"]):
                agg[typ][f"recall@{k}"].append(recall)
    return agg, per_q


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--k", default="10,50,200")
    ap.add_argument("--baseline", default=None, help="run-dir to compare against, paired bootstrap")
    ap.add_argument("--draws", type=int, default=4000)
    a = ap.parse_args()
    ks = [int(x) for x in a.k.split(",")]
    data = json.load(open(a.dataset, encoding="utf-8"))
    evidence = {q["question_id"]: evidence_texts(q) for q in data}
    agg, per_q = score_run(a.run_dir, evidence, ks)
    for typ, m in agg.items():
        n = len(next(iter(m.values())))
        cells = "  ".join(f"{name} {100 * sum(v) / len(v):.1f}" for name, v in m.items())
        print(f"{typ:>22} n={n:<4} {cells}")
    if a.baseline:
        _, base_q = score_run(a.baseline, evidence, ks)
        for k in ks:
            ids = sorted(set(per_q[k]) & set(base_q[k]))
            diffs = [per_q[k][i] - base_q[k][i] for i in ids]
            d, lo, hi = boot(diffs, a.draws)
            print(f"minus baseline recall@{k}: {100 * d:+.1f} [{100 * lo:+.1f}, {100 * hi:+.1f}] n={len(ids)}")


if __name__ == "__main__":
    main()
