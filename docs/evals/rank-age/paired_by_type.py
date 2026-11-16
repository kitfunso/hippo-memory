"""Paired B-minus-A evidence recall per question category, plus the alive share (rank-age prereg, G2 and G3).

Reuses the scorer's own score_run, so the numbers match evidence_recall.py and longmemeval_evidence_recall.py.
Usage: python -I paired_by_type.py --bench locomo|lme --scorers <benchmarks/public> --dataset <json>
           --a <run-dir A> --b <run-dir B> [--k 10,50] [--draws 4000]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from collections import defaultdict


def load_rows(run_dir: str) -> dict:
    """question_id -> (category, top-10 memories), skipping checkpoint files."""
    out = {}
    for f in glob.glob(os.path.join(run_dir, "**", "*.json"), recursive=True):
        if os.path.basename(f).startswith("_"):
            continue
        q = json.load(open(f, encoding="utf-8"))
        cat = q.get("category_name") or q.get("question_type")
        out[q["question_id"]] = (cat, [r["memory"] for r in q["retrieval"]["search_results"][:10]])
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bench", choices=["locomo", "lme"], required=True)
    ap.add_argument("--scorers", required=True)
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--a", required=True)
    ap.add_argument("--b", required=True)
    ap.add_argument("--k", default="10,50")
    ap.add_argument("--draws", type=int, default=4000)
    a = ap.parse_args()
    sys.path.insert(0, a.scorers)
    ks = [int(x) for x in a.k.split(",")]
    data = json.load(open(a.dataset, encoding="utf-8"))
    if a.bench == "locomo":
        import evidence_recall as sc
        ref = {i: sc.turn_texts(c) for i, c in enumerate(data)}
    else:
        import longmemeval_evidence_recall as sc
        ref = {q["question_id"]: sc.evidence_texts(q) for q in data}
    _, qa = sc.score_run(a.a, ref, ks)
    _, qb = sc.score_run(a.b, ref, ks)
    rows_a, rows_b = load_rows(a.a), load_rows(a.b)
    both = sorted(set(rows_a) & set(rows_b))
    differ = sum(rows_a[i][1] != rows_b[i][1] for i in both)
    print(json.dumps({"questions": len(both), "top10_differ": differ, "share": differ / len(both),
                      "alive": differ / len(both) >= 0.01}))
    for k in ks:
        by_cat: dict = defaultdict(list)
        for i in sorted(set(qa[k]) & set(qb[k])):
            d = qb[k][i] - qa[k][i]
            by_cat["all"].append(d)
            by_cat[rows_a[i][0]].append(d)
        for cat, diffs in sorted(by_cat.items()):
            d, lo, hi = sc.boot(diffs, a.draws)
            print(f"recall@{k} {cat:>26} n={len(diffs):<4} B-A {100 * d:+.1f} [{100 * lo:+.1f}, {100 * hi:+.1f}]")


if __name__ == "__main__":
    main()
