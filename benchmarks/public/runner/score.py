"""Score a runner benchmark (prereg Amendment 6): hippo@365 minus bm25 on the main score, paired by question.

Stops unless every saved result matches the call logs (answer_judge.verify), both arms hold exactly the benchmark's
questions, and each arm's retrieval check passed on the files as they are now. Never scores a smoke run or a partial one.
Main score: LongMemEval judge accuracy at top 200 (top 10 secondary); BEAM mean rubric-nugget score at the runner's
cutoff 100 (pass rate at 0.5, the runner's other headline, secondary). Reading: Amendment 2's rule, h2h.reading.
Every primary leaves out the smoke items in smoke_excluded.json and resamples the unit that owns a store: the question
for LongMemEval (one haystack each), the conversation for BEAM (prereg Amendment 6 revision 1 items 4 and 9).
Usage (runner venv): python -I score.py --bench B --pred hippo365=DIR --pred bm25=DIR --out DIR [--bonferroni K]
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
from h2h import by_unit, paired, primary_lines, reading  # noqa: E402
from qa.ledger import smoke_excluded  # noqa: E402

EXPECT = {"longmemeval-s": 500, "longmemeval-m": 500, "beam-100k": 400, "beam-500k": 700, "beam-1m": 700, "beam-10m": 200}
X, Y = "hippo365", "bm25"


def unit_of(bench: str):
    """The unit that owns a store: a LongMemEval question has its own haystack; a BEAM id is <size>_<conv>_q<i>_<type>."""
    return str if aj.kind_of(bench) == "lme" else (lambda qid: qid.rsplit("_q", 1)[0])


def per_question(bench: str, recs: dict) -> dict[str, dict]:
    """{metric: {(arm, qid): value}} and {"type": {qid: type}}. A question with no valid answer in 3 asks scores 0."""
    m: dict[str, dict] = defaultdict(dict)
    for (arm, qid), r in recs.items():
        res = r["result"]
        m["type"][qid] = res["question_type"]
        if "cutoff_results" not in res:
            for metric in ("acc@200", "acc@10") if aj.kind_of(bench) == "lme" else ("score", "pass"):
                m[metric][(arm, qid)] = 0.0
            continue
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


def metric_lines(bench: str, m: dict, ids: list[str], kept: list[str], arms: list[str],
                 k: int | None) -> tuple[list[str], dict]:
    """Each metric's arm means over the primary's questions and hippo365 - bm25 overall and per question type."""
    unit, types = unit_of(bench), sorted(set(m["type"].values()))
    primary, secondary = ("acc@200", ["acc@10"]) if aj.kind_of(bench) == "lme" else ("score", ["pass"])
    lines: list[str] = []
    pairs: dict = {}
    for metric in [primary, *secondary]:
        lines.append(f"\n=== {metric}{'  PRIMARY' if metric == primary else '  secondary'} ===")
        for arm in arms:
            vals = [m[metric][(arm, q)] for q in kept]
            lines.append(f"{arm:>9}  n={len(vals)}  mean {100 * sum(vals) / len(vals):5.1f}")
        diff = {q: m[metric][(X, q)] - m[metric][(Y, q)] for q in ids}
        for label, sel in [("all", kept), *[(t, [q for q in kept if m["type"][q] == t]) for t in types]]:
            if not sel:
                continue
            if metric == primary and label == "all":
                lines += primary_lines(f"{X} - {Y} {label:>26}", diff, kept, ids, unit, k)
            else:
                lines.append(f"{X} - {Y} {label:>26}: {paired(diff, sel, unit)}")
            d, lo, hi, n_units = by_unit(diff, sel, unit)
            pairs[f"{metric}/{label}"] = {"diff": d, "lo": lo, "hi": hi, "n": len(sel), "units": n_units,
                                          "reading": reading(d, lo, hi)}
    return lines, pairs


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bench", required=True, choices=aj.BENCHES)
    ap.add_argument("--pred", action="append", required=True, metavar="ARM=DIR")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--bonferroni", type=int, metavar="K", help="also the primary's interval at 1 - 0.05/K")
    a = ap.parse_args()
    if a.bonferroni is not None and a.bonferroni < 1:
        ap.error("--bonferroni K needs K of 1 or more")
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
    m, smoke = per_question(a.bench, recs), smoke_excluded(a.bench, ids)
    kept = [q for q in ids if q not in smoke]
    body, pairs = metric_lines(a.bench, m, ids, kept, list(arms), a.bonferroni)
    lines = [f"{a.bench}: {len(ids)} questions, {len(kept)} in the primary, results {len(recs)}, all match the call "
             f"logs", *notes, *body]
    out = {"bench": a.bench, "questions": len(ids), "primary_questions": len(kept), "pairs": pairs}
    for arm in arms:
        mem = [v for (ar, _), v in m.get("memories@200", m.get("memories", {})).items() if ar == arm]
        lines.append(f"{arm:>9}  memories per answer at the primary cutoff {sum(mem) / len(mem):6.1f}")
    if "tau_missing" in m:
        lines.append("event-ordering questions whose tau-b step failed and was dropped: " + ", ".join(
            f"{arm} {int(sum(v for (ar, _), v in m['tau_missing'].items() if ar == arm))}" for arm in arms))
    spent = [f"  {arm} {q}: {', '.join(r['result']['exhausted'])}" for (arm, q), r in sorted(recs.items())
             if r["result"].get("exhausted")]
    lines += ["", f"smoke items left out of every primary: {', '.join(sorted(smoke)) or 'none'}",
              f"questions with a prompt exhausted after 3 asks (that step scored wrong): {len(spent)}", *spent]
    text = "\n".join(lines)
    (a.out / "score.txt").write_text(text + "\n", encoding="utf-8")
    (a.out / "score.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
