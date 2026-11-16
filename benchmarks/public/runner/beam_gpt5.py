"""Score lane B5 (prereg dated notes 29): BEAM answered and judged by gpt-5, read by Mem0's own compute_beam_metrics.

Stops unless every saved result matches the call logs (answer_judge.verify) and the arm holds all of the size's
questions. The comparison figure is the runner's overall avg_score at each cutoff over every question, the number
Mem0's result files report; the primary leaves out the lane's smoke items.
Usage (runner venv): python -I beam_gpt5.py --size {1m,10m} --arm ARM
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE)]
import answer_judge as aj  # noqa: E402
import h2h  # noqa: E402
from qa.ledger import smoke_excluded  # noqa: E402
from qa.openai_reasoning import TOO_LONG  # noqa: E402

R2 = Path.home() / "hippo-bench" / "results-r2"
PRED = {"hippo-emb": "beam-{s}-emb/retrieval/hippo-emb/predicted_beam-{s}",
        "bm25": "beam-{s}/retrieval/bm25/predicted_beam-{s}",
        "hippo365": "beam-{s}/retrieval/hippo365/predicted_beam-{s}"}
OUT = R2 / "beam-gpt5"
CUTOFFS = [200, 50]
EXPECT = {"1m": 700, "10m": 200}


def pred(size: str, arm: str) -> Path:
    return R2 / PRED[arm].format(s=size)


def score_lines(results: dict[str, dict], ids: list[str], smoke: set[str]) -> tuple[list[str], dict]:
    """The runner's overall score and pass rate at each cutoff, over every item and over the primary."""
    lines, metrics = [], {}
    for name, sel in (("all items", ids), ("primary", [i for i in ids if i not in smoke])):
        m = metrics[name] = aj.beam.compute_beam_metrics([results[i] for i in sel], CUTOFFS)
        for c in CUTOFFS:
            o = m[aj.beam.cutoff_label(c)]["overall"]
            lines.append(f"top_{c}  score {100 * o['avg_score']:5.1f}  pass {o['accuracy']:5.1f}  n={o['total']}  {name}")
    for c in CUTOFFS:
        empty = sum(results[i].get("cutoff_results", {}).get(aj.beam.cutoff_label(c), {}).get("generated_answer") == ""
                    for i in ids)
        lines.append(f"top_{c}  empty answers {empty}")
    lines.append(f"answers with no valid reply in 3 asks (scored 0): {sum('cutoff_results' not in results[i] for i in ids)}")
    return lines, metrics


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--size", choices=tuple(EXPECT), required=True)
    ap.add_argument("--arm", choices=tuple(PRED), required=True)
    a = ap.parse_args()
    bench, d, out = f"beam-{a.size}", pred(a.size, a.arm), OUT / a.size / a.arm
    ids = aj.pick(bench, {a.arm: d}, 0)
    if len(ids) != EXPECT[a.size]:
        sys.exit(f"{a.arm} holds {len(ids)} {bench} questions, not {EXPECT[a.size]}")
    note = aj.check_retrieval(a.arm, d, ids)
    recs = aj.verify(bench, {a.arm: d}, out, ids, "gpt-5", CUTOFFS)
    results = {qid: r["result"] for (arm, qid), r in recs.items() if arm == a.arm}
    if missing := sorted(set(ids) - set(results)):
        sys.exit(f"{len(missing)} of {len(ids)} questions have no result yet, e.g. {missing[0]}; run answer_judge again")
    lines, metrics = score_lines(results, ids, smoke_excluded(f"{bench}-gpt5", ids))
    refused = {(r["tag"], r["user"]) for r in h2h.read_jsonl(out / "calls-answer.jsonl") if r.get("text") == TOO_LONG}
    lines = [f"BEAM-{a.size.upper()}, {a.arm}: gpt-5-2025-08-07 answers and judge as Mem0's client sends them, "
             f"cutoffs {CUTOFFS} of 200 retrieved (prereg dated notes 29)", f"{a.arm}: {note}", *lines,
             f"answer prompts over gpt-5's 272,000-token input limit, answered empty as Mem0's client does: {len(refused)}"]
    (out / "score.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (out / "score.json").write_text(json.dumps(metrics, indent=1), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
