"""Paired A/B harness for hippo recall flags.

Runs the LoCoMo evidence benchmark twice on the SAME N QAs:
  * arm A (default): no extra recall args
  * arm B (feature):  HIPPO_RECALL_EXTRA_ARGS=<flag>

Then pairs per QA and reports:
  * mean per-QA delta (arm B - arm A)
  * per-category mean delta
  * Wilcoxon signed-rank p-value (no scipy dependency — uses ranks-of-abs-diffs
    + normal approximation, fine for N >= 20)
  * sign-test (count B>A, B<A, ties)
  * fire-rate: fraction of QAs where the retrieved_dia_ids differ between arms.
    A flag that never changes retrieval can't have a non-zero effect; this
    distinguishes "no signal" from "didn't fire".

Why this beats raw mean-diff at N=50: variance dominates absolute scores, so
the unpaired smoke A/B I ran earlier (default 0.171 vs EVC-on 0.177) is
dominated by which QAs landed in the sample, not the feature. Pairing on the
same QAs cancels that variance — only the feature-induced delta remains.

Usage:
  # 1. Run both arms (caller can do this manually too)
  python benchmarks/ab/run.py orchestrate \\
      --flag --evc-adaptive --tag acc-evc \\
      --conversations 5 --sample 10

  # 2. Or analyse two existing incremental.jsonl files directly:
  python benchmarks/ab/run.py compare \\
      --a benchmarks/locomo/results/hippo-smoke-default-n50.incremental.jsonl \\
      --b benchmarks/locomo/results/hippo-smoke-acc-evc-on-n50.incremental.jsonl \\
      --label acc-evc

The orchestrate mode reuses benchmarks/locomo/run.py — no duplication.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shlex
import statistics
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HIPPO_ROOT = ROOT.parent.parent


def load_jsonl(path: Path) -> dict[tuple[str, int], dict]:
    """Index per-QA records by (conversation_id, qa_index)."""
    rows: dict[tuple[str, int], dict] = {}
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            key = (row["conversation_id"], row["qa_index"])
            rows[key] = row
    return rows


def wilcoxon_pvalue(diffs: list[float]) -> float | None:
    """Two-sided Wilcoxon signed-rank test, normal approximation.
    Returns None if N (after dropping zeros) is too small."""
    nonzero = [d for d in diffs if d != 0]
    n = len(nonzero)
    if n < 8:
        return None
    abs_sorted = sorted([(abs(d), 1 if d > 0 else -1) for d in nonzero])
    # Average ranks for ties on |d|
    ranks: list[float] = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and abs_sorted[j + 1][0] == abs_sorted[i][0]:
            j += 1
        avg_rank = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[k] = avg_rank
        i = j + 1
    w_plus = sum(r for r, (_, sign) in zip(ranks, abs_sorted) if sign > 0)
    w_minus = sum(r for r, (_, sign) in zip(ranks, abs_sorted) if sign < 0)
    w = min(w_plus, w_minus)
    mean = n * (n + 1) / 4
    var = n * (n + 1) * (2 * n + 1) / 24
    if var <= 0:
        return None
    z = (w - mean) / math.sqrt(var)
    # Two-sided p-value via standard normal approximation
    p = math.erfc(abs(z) / math.sqrt(2))
    return p


def compare(a_path: Path, b_path: Path, label: str) -> dict:
    a = load_jsonl(a_path)
    b = load_jsonl(b_path)
    common = sorted(set(a.keys()) & set(b.keys()))
    if not common:
        raise SystemExit(f"no overlapping QAs between {a_path} and {b_path}")

    diffs: list[float] = []
    fire_count = 0
    by_cat: dict[str, list[float]] = defaultdict(list)
    cat_fires: dict[str, int] = defaultdict(int)
    for key in common:
        ra, rb = a[key], b[key]
        d = float(rb.get("score", 0)) - float(ra.get("score", 0))
        diffs.append(d)
        cat = ra.get("category_name", "unknown")
        by_cat[cat].append(d)
        # Fire rate: top-k retrieval order differs?
        ra_ids = tuple(ra.get("retrieved_dia_ids", []))
        rb_ids = tuple(rb.get("retrieved_dia_ids", []))
        if ra_ids != rb_ids:
            fire_count += 1
            cat_fires[cat] += 1

    n = len(diffs)
    mean_d = statistics.fmean(diffs)
    pos = sum(1 for d in diffs if d > 0)
    neg = sum(1 for d in diffs if d < 0)
    ties = n - pos - neg
    p = wilcoxon_pvalue(diffs)
    fire_rate = fire_count / n if n else 0.0

    per_cat = {}
    for cat, ds in sorted(by_cat.items()):
        per_cat[cat] = {
            "n": len(ds),
            "mean_delta": round(statistics.fmean(ds), 4),
            "fire_rate": round(cat_fires[cat] / len(ds), 3) if ds else 0.0,
        }

    report = {
        "label": label,
        "a_path": str(a_path),
        "b_path": str(b_path),
        "n_paired": n,
        "mean_delta": round(mean_d, 4),
        "n_positive": pos,
        "n_negative": neg,
        "n_tie": ties,
        "wilcoxon_p_two_sided": round(p, 4) if p is not None else None,
        "fire_rate": round(fire_rate, 3),
        "per_category": per_cat,
    }
    return report


def print_report(r: dict) -> None:
    print(f"\n=== A/B paired report: {r['label']} ===")
    print(f"  paired N        : {r['n_paired']}")
    print(f"  mean Δ (B-A)    : {r['mean_delta']:+.4f}")
    print(f"  win/tie/loss    : {r['n_positive']}/{r['n_tie']}/{r['n_negative']}")
    p = r["wilcoxon_p_two_sided"]
    print(f"  Wilcoxon p      : {p if p is None else f'{p:.4f}'}{'  (>0.05 = no detectable effect)' if (p is not None and p > 0.05) else ''}")
    print(f"  fire-rate       : {r['fire_rate']*100:.1f}%  (= QAs where retrieval order changed)")
    print(f"  per category:")
    for cat, c in r["per_category"].items():
        print(f"    {cat:20s} n={c['n']:3d} Δ={c['mean_delta']:+.4f} fired={c['fire_rate']*100:.0f}%")
    if r["fire_rate"] < 0.05:
        print("  ⚠  fire-rate < 5% — feature barely activates on this benchmark; absence of effect is uninformative.")
    elif p is not None and p > 0.05 and abs(r["mean_delta"]) < 0.02:
        print("  ✓  no detectable effect, but the flag DID fire on a meaningful share of queries.")


def orchestrate(args) -> None:
    locomo_run = HIPPO_ROOT / "benchmarks" / "locomo" / "run.py"
    if not locomo_run.exists():
        raise SystemExit(f"missing {locomo_run}")
    out_dir = HIPPO_ROOT / "benchmarks" / "locomo" / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    common_args = [
        sys.executable, str(locomo_run),
        "--data", str(HIPPO_ROOT / "benchmarks" / "locomo" / "data" / "locomo10.json"),
        "--output-dir", str(out_dir),
        "--conversations", str(args.conversations),
        "--sample", str(args.sample),
        "--score-mode", "evidence",
    ]
    a_name = f"ab-{args.tag}-default-c{args.conversations}s{args.sample}"
    b_name = f"ab-{args.tag}-on-c{args.conversations}s{args.sample}"

    env_a = os.environ.copy()
    env_a.pop("HIPPO_RECALL_EXTRA_ARGS", None)
    print(f">> running default arm: {a_name}")
    subprocess.run(common_args + ["--output-name", a_name], env=env_a, check=True, cwd=str(HIPPO_ROOT))

    env_b = os.environ.copy()
    env_b["HIPPO_RECALL_EXTRA_ARGS"] = args.flag
    print(f">> running feature arm: {b_name}  (HIPPO_RECALL_EXTRA_ARGS={args.flag!r})")
    subprocess.run(common_args + ["--output-name", b_name], env=env_b, check=True, cwd=str(HIPPO_ROOT))

    a_jsonl = out_dir / f"{a_name}.incremental.jsonl"
    b_jsonl = out_dir / f"{b_name}.incremental.jsonl"
    report = compare(a_jsonl, b_jsonl, args.tag)
    print_report(report)
    out_path = out_dir / f"ab-{args.tag}-report.json"
    out_path.write_text(json.dumps(report, indent=2))
    print(f"\nwrote {out_path}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Paired A/B for hippo recall flags")
    sub = ap.add_subparsers(dest="cmd", required=True)

    o = sub.add_parser("orchestrate", help="Run both arms and analyse")
    o.add_argument("--flag", required=True, help="The --flag (or 'flag1 flag2') to set as HIPPO_RECALL_EXTRA_ARGS for arm B")
    o.add_argument("--tag", required=True, help="Short tag for output filenames (e.g. acc-evc)")
    o.add_argument("--conversations", type=int, default=5)
    o.add_argument("--sample", type=int, default=10)

    c = sub.add_parser("compare", help="Analyse two existing incremental.jsonl files")
    c.add_argument("--a", required=True, type=Path, help="default arm jsonl")
    c.add_argument("--b", required=True, type=Path, help="feature arm jsonl")
    c.add_argument("--label", required=True)

    args = ap.parse_args()
    if args.cmd == "orchestrate":
        orchestrate(args)
    elif args.cmd == "compare":
        report = compare(args.a, args.b, args.label)
        print_report(report)
        out_path = HIPPO_ROOT / "benchmarks" / "locomo" / "results" / f"ab-{args.label}-report.json"
        out_path.write_text(json.dumps(report, indent=2))
        print(f"\nwrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
