"""Score a Terminal-Bench run of run_tbench.py: pass rate per arm and `hippo` minus `none`, paired by task.

  python -I score_tbench.py --out RUN [--exclude task,...] [--json FILE]

Reads RUN/progress.jsonl and order.json. Per (task, arm) the first non-infrastructure trial counts;
a task missing either arm is listed and left out of the pairing. Interval: `boot` (evidence_recall.py,
4,000 draws, seed 1) over per-task differences; reading: Amendment 2's rule (`reading` in h2h.py).
Secondary: a block bootstrap over runs of 10 consecutive tasks in run order, since the hippo store
carries from task to task, and the pass-rate difference over the first and second half of the order.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE.parent / "mem0")]
from evidence_recall import boot  # noqa: E402
from h2h import read_jsonl, reading  # noqa: E402


def block_boot(diffs: list[float], block: int = 10, draws: int = 4000) -> tuple[float, float]:
    """95% interval of the mean from contiguous blocks of `block` tasks in run order."""
    rng = random.Random(1)
    blocks = [diffs[i:i + block] for i in range(0, len(diffs), block)]
    means = []
    for _ in range(draws):
        pick = [x for _ in blocks for x in rng.choice(blocks)]
        means.append(sum(pick) / len(pick))
    means.sort()
    return means[int(0.025 * draws)], means[int(0.975 * draws) - 1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--exclude", default="", help="smoke tasks, left out of the primary")
    ap.add_argument("--json", type=Path)
    a = ap.parse_args()
    order = json.loads((a.out / "order.json").read_text(encoding="utf-8"))["tasks"]
    excluded = {x for x in a.exclude.split(",") if x}
    first: dict[tuple[str, str], dict] = {}
    for r in read_jsonl(a.out / "progress.jsonl"):
        if not r.get("infra"):
            first.setdefault((r["task"], r["arm"]), r)
    paired, missing = [], []
    for t in order:
        name = t["task"]
        if name in excluded:
            continue
        h, n = first.get((name, "hippo")), first.get((name, "none"))
        if h is None or n is None:
            missing.append(name)
            continue
        paired.append({"idx": t["idx"], "task": name, "hippo": h["reward"] >= 1.0, "none": n["reward"] >= 1.0})
    if not paired:
        sys.exit("no task has both arms finished")
    diffs = [float(p["hippo"]) - float(p["none"]) for p in paired]
    d, lo, hi = boot(diffs)
    blo, bhi = block_boot(diffs)
    half = len(diffs) // 2
    res = {
        "n_paired": len(paired), "excluded": sorted(excluded), "missing": missing,
        "pass_rate": {arm: sum(p[arm] for p in paired) / len(paired) for arm in ("hippo", "none")},
        "primary": {"diff": d, "lo": lo, "hi": hi, "reading": reading(d, lo, hi)},
        "secondary": {
            "block10_interval": [blo, bhi],
            "discordant": {"hippo_only": sum(p["hippo"] and not p["none"] for p in paired),
                           "none_only": sum(p["none"] and not p["hippo"] for p in paired)},
            "diff_first_half": sum(diffs[:half]) / max(half, 1),
            "diff_second_half": sum(diffs[half:]) / max(len(diffs) - half, 1)},
        "tasks": paired,
    }
    text = json.dumps(res, indent=2)
    if a.json:
        a.json.write_text(text, encoding="utf-8")
    print(json.dumps({k: v for k, v in res.items() if k != "tasks"}, indent=2))


if __name__ == "__main__":
    main()
