"""Score a runner benchmark (prereg Amendment 6): hippo@365 minus bm25 on the main score, paired by question.

Stops unless every saved result matches the call logs (answer_judge.verify), both arms hold exactly the benchmark's
questions, and each arm's retrieval check passed on the files as they are now. Never scores a smoke run or a partial one.
Main score: LongMemEval judge accuracy at top 200 (top 10 secondary); BEAM mean rubric-nugget score at the runner's
cutoff 100 (pass rate at 0.5, the runner's other headline, secondary). Reading: Amendment 2's rule, h2h.reading.
Usage (runner venv): python -I score.py --bench B --pred hippo365=DIR --pred bm25=DIR --out DIR
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE)]
import answer_judge as aj  # noqa: E402
from evidence_recall import boot  # noqa: E402
from h2h import reading  # noqa: E402

EXPECT = {"longmemeval-s": 500, "longmemeval-m": 500, "beam-100k": 400, "beam-500k": 700, "beam-1m": 700, "beam-10m": 200}
X, Y = "hippo365", "bm25"


def per_question(bench: str, recs: dict) -> dict[str, dict]:
    """{metric: {(arm, qid): value}} and {"type": {qid: type}}."""
    m: dict[str, dict] = defaultdict(dict)
    for (arm, qid), r in recs.items():
        res = r["result"]
        m["type"][qid] = res["question_type"]
        if aj.kind_of(bench) == "lme":
            for lab in ("top_200", "top_10"):
                c = res["cutoff_results"][lab]
                m[f"acc@{lab[4:]}"][(arm, qid)] = c["score"]
                m[f"memories@{lab[4:]}"][(arm, qid)] = c["memories_evaluated"]
        else:
            c = res["cutoff_results"]["top_100"]
            m["score"][(arm, qid)] = c["score"]
            m["pass"][(arm, qid)] = float(c["judgment"] == "PASS")
            m["memories"][(arm, qid)] = c["memories_evaluated"]
            if res["question_type"] == "event_ordering":
                m["tau_missing"][(arm, qid)] = float("event_ordering" not in c)
    return m


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bench", required=True, choices=aj.BENCHES)
    ap.add_argument("--pred", action="append", required=True, metavar="ARM=DIR")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    arms = {s.split("=", 1)[0]: Path(s.split("=", 1)[1]) for s in a.pred}
    if set(arms) != {X, Y}:
        sys.exit(f"--pred needs exactly {X} and {Y}")
    ids = sorted(set(aj.pred_files(arms[X])) & set(aj.pred_files(arms[Y])))
    if len(ids) != EXPECT[a.bench]:
        sys.exit(f"{len(ids)} questions in both arms, {EXPECT[a.bench]} expected: never scored partial")
    aj.check_inputs(a.out, arms, ids)
    recs = aj.verify(a.bench, arms, a.out, ids)
    if set(recs) != {(arm, q) for arm in arms for q in ids}:
        sys.exit(f"{len(recs)} results for {2 * len(ids)} (arm, question) pairs: never scored partial")
    notes = [f"{arm}: {aj.check_retrieval(arm, d, ids)}" for arm, d in arms.items()]
    m = per_question(a.bench, recs)
    types = sorted(set(m["type"].values()))
    primary, secondary = ("acc@200", ["acc@10"]) if aj.kind_of(a.bench) == "lme" else ("score", ["pass"])
    lines = [f"{a.bench}: {len(ids)} questions, results {len(recs)}, all match the call logs", *notes]
    out: dict = {"bench": a.bench, "questions": len(ids), "pairs": {}}
    for metric in [primary, *secondary]:
        lines.append(f"\n=== {metric}{'  PRIMARY' if metric == primary else '  secondary'} ===")
        for arm in arms:
            vals = [m[metric][(arm, q)] for q in ids]
            lines.append(f"{arm:>9}  n={len(vals)}  mean {100 * sum(vals) / len(vals):5.1f}")
        for label, sel in [("all", ids), *[(t, [q for q in ids if m["type"][q] == t]) for t in types]]:
            d, lo, hi = boot([m[metric][(X, q)] - m[metric][(Y, q)] for q in sel])
            lines.append(f"{'PRIMARY ' if metric == primary and label == 'all' else ''}{X} - {Y} {label:>26}: "
                         f"{100 * d:+5.1f} pp [{100 * lo:+5.1f}, {100 * hi:+5.1f}] n={len(sel)}  {reading(d, lo, hi)}")
            out["pairs"][f"{metric}/{label}"] = {"diff": d, "lo": lo, "hi": hi, "n": len(sel), "reading": reading(d, lo, hi)}
    for arm in arms:
        mem = [v for (ar, _), v in m.get("memories@200", m.get("memories", {})).items() if ar == arm]
        lines.append(f"{arm:>9}  memories per answer at the primary cutoff {sum(mem) / len(mem):6.1f}")
    if "tau_missing" in m:
        lines.append("event-ordering questions whose tau-b step failed and was dropped: " + ", ".join(
            f"{arm} {int(sum(v for (ar, _), v in m['tau_missing'].items() if ar == arm))}" for arm in arms))
    text = "\n".join(lines)
    (a.out / "score.txt").write_text(text + "\n", encoding="utf-8")
    (a.out / "score.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
