"""LoCoMo head-to-head with Mem0 (prereg Amendment 4): answer, judge and score three arms on the Lane A sample.

Prompts and parsing are Mem0's runner's at 4b61c5d (run.py:529-556), one `claude -p` call each through claude_llm.py.
Usage: python h2h.py {answer,judge,score} --run SCRATCH_DIR --out RESULTS_DIR [--slots 10]
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import random
import sys
import types
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNNER = Path("C:/Users/skf_s/hippo-bench/memory-benchmarks")
LOCOMO = Path("C:/Users/skf_s/hippo-bench/locomo")
LANE_R = Path("C:/Users/skf_s/hippo/benchmarks/public/results/2026-09-25-lane-r/predicted")
SAMPLE = HERE.parent / "results" / "2026-09-25-lane-a" / "locomo" / "sample.json"
ARMS, CUTOFFS = ("hippo365", "bm25", "mem0"), (200, 50, 10)
CAT = {1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop"}

sys.path[:0] = [str(HERE), str(HERE.parent), str(RUNNER)]
from benchmarks.locomo.prompts import (JUDGE_SYSTEM_PROMPT, get_answer_generation_prompt,  # noqa: E402
                                       get_judge_prompt, preprocess_answer)
from claude_llm import Claude, json_reply  # noqa: E402
from evidence_recall import boot  # noqa: E402


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def qa_of(data: list, qid: str) -> dict:
    conv, qi = qid.split("_q")
    return data[int(conv[4:])]["qa"][int(qi)]


def predicted(run: Path, arm: str, qid: str) -> dict:
    d = run / "ingest" / "predicted_locomo-mem0" if arm == "mem0" else LANE_R / f"predicted_locomo-{arm}"
    return load(d / f"{qid}.json")


def tokens_in(rec: dict) -> int:
    u = rec.get("usage") or {}
    return sum(u.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))


def run_all(jobs: list[tuple], fn, out: Path, slots: int) -> None:
    """Runs every job, appending each result as it lands, so a rerun resumes; failed jobs are named, never skipped."""
    failed = []
    with ThreadPoolExecutor(slots) as pool:
        futs = {pool.submit(fn, j): j[:3] for j in jobs}
        for n, f in enumerate(as_completed(futs), 1):
            try:
                rec = f.result()
            except RuntimeError as e:
                failed.append(f"{futs[f]}: {e}")
                continue
            with out.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if n % 100 == 0:
                print(f"{n}/{len(jobs)}", flush=True)
    if failed:
        sys.exit(f"{len(failed)} of {len(jobs)} calls failed; rerun to retry them:\n" + "\n".join(failed[:20]))


def answer(a: argparse.Namespace) -> None:
    out = a.out / "answers.jsonl"
    done = {(r["arm"], r["cutoff"], r["qid"]) for r in read_jsonl(out)}
    jobs = []
    for arm in ARMS:
        for qid in load(SAMPLE):
            q = predicted(a.run, arm, qid)
            for c in CUTOFFS:
                if (arm, c, qid) not in done:
                    hits = q["retrieval"]["search_results"][:c]
                    prompt = get_answer_generation_prompt(q["question"], hits, reference_date=q.get("reference_date"),
                                                          user_profile=q.get("user_profile"))
                    jobs.append((arm, c, qid, len(hits), prompt))
    random.Random(4).shuffle(jobs)  # arms interleaved, so a slow or limited stretch hits all three alike
    claude = Claude(a.run / "claude", a.run / "calls-answer.jsonl", a.slots)

    def one(job: tuple) -> dict:
        arm, c, qid, n, prompt = job
        r = claude.ask("", prompt, effort="medium", tag=f"answer {arm} {c} {qid}")
        text = r["text"]
        ans = text.rsplit("ANSWER:", 1)[-1].strip() if "ANSWER:" in text else text
        return {"arm": arm, "cutoff": c, "qid": qid, "memories": n, "tokens_in": tokens_in(r), "answer": ans}

    print(f"{len(jobs)} answers to make, {len(done)} already made", flush=True)
    run_all(jobs, one, out, a.slots)


def judge(a: argparse.Namespace) -> None:
    data = load(LOCOMO / "data" / "locomo10.json")
    answers = {(r["arm"], r["cutoff"], r["qid"]): r["answer"] for r in read_jsonl(a.out / "answers.jsonl")}
    need = len(ARMS) * len(CUTOFFS) * len(load(SAMPLE))
    if len(answers) != need:
        sys.exit(f"{len(answers)} of {need} answers made; finish the answer stage first")
    key_path = a.out / "judge_key.json"
    if not key_path.exists():
        items = sorted(answers)
        random.Random(7).shuffle(items)
        key = {f"j{i:05d}": {"arm": arm, "cutoff": c, "qid": qid} for i, (arm, c, qid) in enumerate(items)}
        key_path.write_text(json.dumps(key, indent=0), encoding="utf-8")
    out = a.out / "verdicts.jsonl"
    done = {r["id"] for r in read_jsonl(out)}
    jobs = []
    for jid, k in load(key_path).items():
        if jid not in done:
            qa = qa_of(data, k["qid"])
            gold = preprocess_answer(qa["category"], str(qa["answer"]))
            response = answers[(k["arm"], k["cutoff"], k["qid"])]
            jobs.append((jid, get_judge_prompt(qa["category"], qa["question"], gold, response)))
    claude = Claude(a.run / "claude", a.run / "calls-judge.jsonl", a.slots)

    def one(job: tuple) -> dict:
        jid, prompt = job
        v = json_reply(claude.ask(JUDGE_SYSTEM_PROMPT, prompt, effort="medium", tag=f"judge {jid}", want_json=True)["text"])
        if len(v) == 1 and isinstance(v.get("final"), dict):  # the runner's unwrap, llm_client.py:288-293
            v = v["final"]
        return {"id": jid, "label": str(v.get("label", "")).upper(), "reasoning": v.get("reasoning", "")}

    print(f"{len(jobs)} verdicts to get, {len(done)} already in", flush=True)
    run_all(jobs, one, out, a.slots)


def reading(d: float, lo: float, hi: float) -> str:
    """Amendment 2's rule, checked in its order."""
    if lo > 0 and d >= 0.03:
        return "beats"
    if hi < 0 and d <= -0.03:
        return "trails"
    if lo >= -0.03 and hi <= 0.03:
        return "matches"
    return "unresolved"


def f1_scores(answers: dict, data: list) -> dict:
    sys.modules.setdefault("bert_score", types.SimpleNamespace(score=None))  # evaluation.py imports it, F1 never uses it
    sys.path.insert(0, str(LOCOMO / "task_eval"))
    import evaluation as ev
    out = {}
    with contextlib.redirect_stdout(io.StringIO()):
        for (arm, c, qid), r in answers.items():
            qa = qa_of(data, qid)
            row = {"answer": qa["answer"], "category": qa["category"], "prediction": r["answer"], "evidence": []}
            out[(arm, c, qid)] = float(ev.eval_question_answering([row], "prediction")[0][0])
    return out


def score(a: argparse.Namespace) -> None:
    data, sample = load(LOCOMO / "data" / "locomo10.json"), load(SAMPLE)
    answers = {(r["arm"], r["cutoff"], r["qid"]): r for r in read_jsonl(a.out / "answers.jsonl")}
    labels = {r["id"]: r["label"] for r in read_jsonl(a.out / "verdicts.jsonl")}
    key = load(a.out / "judge_key.json")
    need = len(ARMS) * len(CUTOFFS) * len(sample)
    if len(answers) != need or len(labels) != need:
        sys.exit(f"{len(answers)} answers and {len(labels)} verdicts of {need}; a partial run is never scored")
    metric = {"F1": f1_scores(answers, data),
              "judge": {(k["arm"], k["cutoff"], k["qid"]): float(labels[j] == "CORRECT") for j, k in key.items() if j in labels}}
    lines = [f"answers {len(answers)}, verdicts {len(labels)}, labels other than CORRECT/WRONG "
             f"{sum(v not in ('CORRECT', 'WRONG') for v in labels.values())}"]
    for c in CUTOFFS:
        lines.append(f"\n=== top {c} ===")
        for arm in ARMS:
            rs = [answers[(arm, c, q)] for q in sample if (arm, c, q) in answers]
            means = "  ".join(f"{m} {100 * sum(metric[m].get((arm, c, q), 0) for q in sample) / len(sample):5.1f}"
                              for m in metric)
            lines.append(f"{arm:>9}  n={len(rs)}  {means}  memories {sum(r['memories'] for r in rs) / max(1, len(rs)):6.1f}"
                         f"  input tokens {sum(r['tokens_in'] for r in rs) / max(1, len(rs)):7.0f}")
        for x, y in (("hippo365", "mem0"), ("bm25", "mem0"), ("hippo365", "bm25")):
            for m, vals in metric.items():
                cats = [(None, sample)] + [(k, [q for q in sample if qa_of(data, q)["category"] == k]) for k in CAT]
                for cat, qs in cats:
                    ids = [q for q in qs if (x, c, q) in vals and (y, c, q) in vals]
                    if not ids or (cat and m == "judge"):
                        continue
                    d, lo, hi = boot([vals[(x, c, q)] - vals[(y, c, q)] for q in ids])
                    tag = "PRIMARY " if (x, y, m, cat) == ("hippo365", "mem0", "F1", None) and c in (200, 50) else ""
                    lines.append(f"{tag}{x} - {y} {m:>5} {CAT.get(cat, 'all'):>11}: {100 * d:+5.1f} pp "
                                 f"[{100 * lo:+5.1f}, {100 * hi:+5.1f}] n={len(ids)}  {reading(d, lo, hi)}")
    text = "\n".join(lines)
    (a.out / "score.txt").write_text(text + "\n", encoding="utf-8")
    print(text)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("answer", "judge", "score"))
    ap.add_argument("--run", type=Path, required=True, help="scratch run dir: Mem0's predicted files, call logs")
    ap.add_argument("--out", type=Path, required=True, help="results dir: answers, judge key, verdicts, score")
    ap.add_argument("--slots", type=int, default=10)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    {"answer": answer, "judge": judge, "score": score}[a.stage](a)


if __name__ == "__main__":
    main()
