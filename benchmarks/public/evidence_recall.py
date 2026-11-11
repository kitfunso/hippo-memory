"""Free retrieval check on Mem0-runner LoCoMo output (no model calls).

For each question, the share of its gold evidence turns found in the top k
retrieved memories, from `--predict-only` output of
mem0ai/memory-benchmarks. Works for any arm whose memories hold the raw turn
text (hippo and bm25 here); Mem0's extracted memories do not, so this cannot
score mem0-oss. Usage:

    python evidence_recall.py --dataset locomo10.json --run-dir out/predicted_<name> [--k 10,50,200]
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


def cluster_boot(diffs_by_unit: dict[str, list[float]], draws: int = 4000,
                 level: float = 0.95) -> tuple[float, float, float]:
    """Paired bootstrap CI that resamples whole units (a conversation, persona or haystack) with all their questions.

    Questions that share a memory store are correlated, so the unit that owns the store is the independent draw
    (prereg Amendment 6, revision 1, item 9). `level` below 0.95 gives the Bonferroni intervals of item 10.
    """
    random.seed(1)
    units = [d for d in diffs_by_unit.values() if d]
    estimate = sum(map(sum, units)) / sum(map(len, units))
    means = []
    for _ in range(draws):
        pick = [random.choice(units) for _ in units]
        means.append(sum(map(sum, pick)) / sum(map(len, pick)))
    means.sort()
    lo, hi = int((1 - level) / 2 * draws), int((1 + level) / 2 * draws) - 1
    return estimate, means[lo], means[hi]


def turn_texts(conv: dict) -> dict[str, str]:
    out = {}
    for key, turns in conv["conversation"].items():
        if not key.startswith("session_") or not isinstance(turns, list):
            continue
        for t in turns:
            text = t.get("text", "")
            if t.get("dia_id") and text:
                out[t["dia_id"]] = f'{t.get("speaker", "")}: {text}'
    return out


def score_run(run_dir: str, texts: dict, ks: list[int]) -> tuple[dict, dict]:
    """agg[cat][metric] -> list of values; per_q[k] -> {question_id: recall}."""
    agg: dict = defaultdict(lambda: defaultdict(list))
    per_q: dict = defaultdict(dict)
    for f in sorted(glob.glob(f"{run_dir}/*.json")):
        q = json.load(open(f))
        ev = [e for e in q.get("evidence", []) if e in texts[q["conversation_idx"]]]
        if not ev:
            continue
        mems = [r["memory"] for r in q["retrieval"]["search_results"]]
        for k in ks:
            top = "\n".join(mems[:k])
            found = sum(texts[q["conversation_idx"]][e] in top for e in ev)
            recall = found / len(ev)
            per_q[k][q["question_id"]] = recall
            for cat in ("all", q["category_name"]):
                agg[cat][f"recall@{k}"].append(recall)
                agg[cat][f"all@{k}"].append(float(found == len(ev)))
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
    data = json.load(open(a.dataset))
    texts = {i: turn_texts(c) for i, c in enumerate(data)}
    agg, per_q = score_run(a.run_dir, texts, ks)
    for cat, m in agg.items():
        n = len(next(iter(m.values())))
        cells = "  ".join(f"{name} {100 * sum(v) / len(v):.1f}" for name, v in m.items())
        print(f"{cat:>12} n={n:<4} {cells}")
    if a.baseline:
        _, base_q = score_run(a.baseline, texts, ks)
        for k in ks:
            ids = sorted(set(per_q[k]) & set(base_q[k]))
            diffs = [per_q[k][i] - base_q[k][i] for i in ids]
            d, lo, hi = boot(diffs, a.draws)
            print(f"minus baseline recall@{k}: {100 * d:+.1f} [{100 * lo:+.1f}, {100 * hi:+.1f}] n={len(ids)}")


if __name__ == "__main__":
    main()
