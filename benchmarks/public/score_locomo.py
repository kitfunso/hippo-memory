from __future__ import annotations

import argparse
import glob
import json
import random
import sys
import types
from collections import defaultdict


def load_official_scorer(repo: str):
    # evaluation.py imports bert_score at module level for an unrelated metric;
    # stub it so the F1 functions load without torch.
    sys.modules.setdefault("bert_score", types.SimpleNamespace(score=None))
    sys.path.insert(0, f"{repo}/task_eval")
    import evaluation  # type: ignore
    return evaluation


def official_f1(ev, answer: str, prediction: str, category: int) -> float:
    rows = [{"answer": answer, "category": category, "prediction": prediction, "evidence": []}]
    ems, _, _ = ev.eval_question_answering(rows, "prediction")
    return float(ems[0])


def boot(diffs: list[float], draws: int = 2000) -> tuple[float, float, float]:
    random.seed(1)
    n = len(diffs)
    means = sorted(sum(random.choice(diffs) for _ in range(n)) / n for _ in range(draws))
    return sum(diffs) / n, means[int(0.025 * draws)], means[int(0.975 * draws) - 1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--locomo-repo", required=True)
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--arm", action="append", required=True, help="name=run_dir")
    ap.add_argument("--baseline", default=None)
    a = ap.parse_args()
    ev = load_official_scorer(a.locomo_repo)
    data = json.load(open(a.dataset))
    arms = dict(x.split("=", 1) for x in a.arm)

    scores: dict = defaultdict(lambda: defaultdict(lambda: defaultdict(dict)))
    for name, run_dir in arms.items():
        for f in glob.glob(f"{run_dir}/*.json"):
            q = json.load(open(f))
            qa_idx = int(q["question_id"].rsplit("_q", 1)[1])
            gold = data[q["conversation_idx"]]["qa"][qa_idx]
            for cut, r in (q.get("cutoff_results") or {}).items():
                ans = r.get("generated_answer", "") or ""
                scores[name][cut]["judge"][q["question_id"]] = float(r.get("score", 0) or 0)
                scores[name][cut]["f1"][q["question_id"]] = official_f1(ev, str(gold["answer"]), ans, int(gold["category"]))

    for name in arms:
        for cut in sorted(scores[name]):
            m = scores[name][cut]
            print(f"{name:>10} {cut:>8}  n={len(m['judge']):<5} judge {100 * sum(m['judge'].values()) / max(1, len(m['judge'])):5.1f}"
                  f"   authors' F1 {100 * sum(m['f1'].values()) / max(1, len(m['f1'])):5.1f}")
    if a.baseline:
        for name in arms:
            if name == a.baseline:
                continue
            for cut in sorted(scores[name]):
                for metric in ("judge", "f1"):
                    A, B = scores[name][cut][metric], scores[a.baseline][cut][metric]
                    ids = sorted(set(A) & set(B))
                    if not ids:
                        continue
                    d, lo, hi = boot([A[i] - B[i] for i in ids])
                    print(f"{name} - {a.baseline} {cut:>8} {metric:>5}: {100 * d:+.1f} pp [{100 * lo:+.1f}, {100 * hi:+.1f}] n={len(ids)}")


if __name__ == "__main__":
    main()
