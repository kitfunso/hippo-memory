"""LoCoMo head-to-head with Mem0 (prereg Amendments 4 and 5): answer, judge and score three arms on the Lane A sample.

Prompts and parsing are Mem0's runner's at 4b61c5d (run.py:529-556), one `claude -p` call each through claude_llm.py.
Usage: python h2h.py {answer,judge,score} --run SCRATCH_DIR --out RESULTS_DIR [--slots 10]
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import random
import re
import sys
import types
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNNER = Path.home() / "hippo-bench" / "memory-benchmarks"
LOCOMO = Path.home() / "hippo-bench" / "locomo"
LANE_R = Path.home() / "hippo" / "benchmarks" / "public" / "results" / "2026-09-25-lane-r" / "predicted"
SAMPLE = HERE.parent / "results" / "2026-09-25-lane-a" / "locomo" / "sample.json"
ARMS, CUTOFFS, LABELS = ("hippo365", "bm25", "mem0"), (200, 50, 10), ("CORRECT", "WRONG")
FENCE = re.compile(r"```[a-zA-Z0-9]*\n([\s\S]*?)\n```")  # a whole-reply code fence, as claude_llm.json_reply reads it
CAT = {1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop"}

sys.path[:0] = [str(HERE), str(HERE.parent), str(RUNNER)]
from benchmarks.locomo.prompts import (JUDGE_SYSTEM_PROMPT, get_answer_generation_prompt,  # noqa: E402
                                       get_judge_prompt, preprocess_answer)
from claude_llm import Claude  # noqa: E402
from evidence_recall import boot  # noqa: E402
from gate import fingerprint  # noqa: E402


def read_jsonl(path: Path) -> list[dict]:
    """The file's records. A kill mid-write can leave a last record without its newline: kept if whole, else cut off."""
    if not path.exists():
        return []
    raw = path.read_bytes()
    cut = raw.rfind(b"\n") + 1
    if cut < len(raw):
        try:
            whole = isinstance(json.loads(raw[cut:].decode("utf-8")), dict)
        except ValueError:  # a record or a UTF-8 character cut short
            whole = False
        if whole:
            with path.open("ab") as f:
                f.write(b"\n")  # so the next append starts a line of its own
            raw += b"\n"
        else:
            print(f"dropped a partial last record from {path.name}: {raw[cut:][:80]!r}", file=sys.stderr)
            with path.open("r+b") as f:
                f.truncate(cut)
            raw = raw[:cut]
    # split on LF alone: an answer may hold U+2028 or U+0085, which str.splitlines() also splits on
    return [json.loads(line) for line in raw.split(b"\n") if line.strip()]


def records(path: Path, by) -> dict:
    """The file's records by key; a key seen twice means two runs wrote at once, so it stops."""
    out = {}
    for r in read_jsonl(path):
        if by(r) in out:
            sys.exit(f"{path.name} holds {by(r)} twice")
        out[by(r)] = r
    return out


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def qa_of(data: list, qid: str) -> dict:
    conv, qi = qid.split("_q")
    return data[int(conv[4:])]["qa"][int(qi)]


def predicted(run: Path, arm: str, qid: str) -> dict:
    d = run / "ingest" / "predicted_locomo-mem0" if arm == "mem0" else LANE_R / f"predicted_locomo-{arm}"
    return load(d / f"{qid}.json")


def tokens_in(rec: dict) -> int:
    u = rec.get("usage") or {}
    return sum(u.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))


def check_gate(run: Path) -> None:
    ingest = run / "ingest"
    g = load(ingest / "gate.json") if (ingest / "gate.json").exists() else {}
    if not g.get("pass") or g.get("fingerprint") != fingerprint(ingest):
        sys.exit("Mem0's ingestion has no passing gate for its current files; run gate.py first (prereg Amendment 5)")


def answer_prompts(run: Path) -> dict:
    """Every answer prompt the design calls for, by (arm, cutoff, qid), with how many memories it shows."""
    prompts = {}
    for arm in ARMS:
        for qid in load(SAMPLE):
            q = predicted(run, arm, qid)
            for c in CUTOFFS:
                hits = q["retrieval"]["search_results"][:c]
                prompts[(arm, c, qid)] = (len(hits), get_answer_generation_prompt(
                    q["question"], hits, reference_date=q.get("reference_date"), user_profile=q.get("user_profile")))
    return prompts


def answers_on_file(out: Path, prompts: dict) -> dict:
    """The answers made so far, each checked to come from the prompt its retrieval file gives now, or stop."""
    answers = records(out / "answers.jsonl", lambda r: (r["arm"], r["cutoff"], r["qid"]))
    stale = [k for k, r in answers.items() if k not in prompts or r.get("prompt") != sha(prompts[k][1])]
    if stale:
        sys.exit(f"answers.jsonl holds {len(stale)} answers outside the design or made from other inputs, "
                 f"e.g. {stale[0]}; move it aside and answer again")
    return answers


def all_answers(run: Path, out: Path) -> dict:
    """Exactly the answers the design calls for, or stop: a count alone can hide a missing answer behind a stray one."""
    prompts = answer_prompts(run)
    answers = answers_on_file(out, prompts)
    if set(answers) != set(prompts):
        sys.exit(f"answers: {len(set(prompts) - set(answers))} of {len(prompts)} missing")
    return answers


def judge_key(out: Path, answers: dict) -> dict:
    """The blind key, checked to map one to one onto the answers as they are now."""
    key = load(out / "judge_key.json")
    items = {(k["arm"], k["cutoff"], k["qid"]): k["sha"] for k in key.values()}
    if len(items) != len(key) or set(items) != set(answers) or any(
            s != sha(answers[i]["answer"]) for i, s in items.items()):
        sys.exit("judge_key.json does not map one to one onto the answers as they are now")
    return key


def verdict(text: str) -> dict | None:
    """A judge reply read as the runner reads it (llm_client.py:285-293), once a code fence around the whole reply is
    removed, since `claude -p` has no JSON mode. None if it holds no CORRECT or WRONG label."""
    t = text.strip()
    fenced = FENCE.fullmatch(t)
    try:
        v = json.loads(fenced[1] if fenced else t)
        if isinstance(v, dict) and len(v) == 1 and "final" in v:
            inner = v["final"]
            v = json.loads(inner) if isinstance(inner, str) else inner if isinstance(inner, dict) else v
    except ValueError:  # the runner's parse fails here too and it asks again
        return None
    label = str(v.get("label", "")).upper() if isinstance(v, dict) else ""
    return {"label": label, "reasoning": v.get("reasoning", "")} if label in LABELS else None


def judge_prompts(key: dict, answers: dict, data: list) -> dict:
    """Each keyed answer's judge prompt: the question, LoCoMo's answer as the runner prepares it, and the answer."""
    prompts = {}
    for jid, k in key.items():
        qa = qa_of(data, k["qid"])
        gold = preprocess_answer(qa["category"], str(qa["answer"]))
        response = answers[(k["arm"], k["cutoff"], k["qid"])]["answer"]
        prompts[jid] = get_judge_prompt(qa["category"], qa["question"], gold, response)
    return prompts


def verdicts_on_file(out: Path, prompts: dict) -> dict:
    """The verdicts so far, each on the judge prompt as it is now and labelled CORRECT or WRONG, or stop."""
    verdicts = records(out / "verdicts.jsonl", lambda r: r["id"])
    bad = [j for j, v in verdicts.items()
           if j not in prompts or v.get("prompt") != sha(prompts[j]) or v.get("label") not in LABELS]
    if bad:
        sys.exit(f"verdicts.jsonl holds {len(bad)} verdicts on other prompts or without a CORRECT or WRONG label, "
                 f"e.g. {bad[0]}; judge again from an empty file")
    return verdicts


def run_all(jobs: list[tuple], fn, out: Path, slots: int) -> None:
    """Runs every job, appending each result as it lands, so a rerun resumes; failed jobs are named, never skipped."""
    failed = []
    with ThreadPoolExecutor(slots) as pool:
        futs = {pool.submit(fn, j): j[:-1] for j in jobs}  # a job's last field is its prompt
        for n, f in enumerate(as_completed(futs), 1):
            try:
                rec = f.result()
            except Exception as e:  # named below and retried by a rerun; the other results still land
                failed.append(f"{futs[f]}: {type(e).__name__}: {e}")
                continue
            with out.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if n % 100 == 0:
                print(f"{n}/{len(jobs)}", flush=True)
    if failed:
        sys.exit(f"{len(failed)} of {len(jobs)} calls failed; rerun to retry them:\n" + "\n".join(failed[:20]))


def answer(a: argparse.Namespace) -> None:
    check_gate(a.run)
    prompts = answer_prompts(a.run)
    done = answers_on_file(a.out, prompts)
    jobs = [(arm, c, qid, n, prompt) for (arm, c, qid), (n, prompt) in prompts.items() if (arm, c, qid) not in done]
    random.Random(4).shuffle(jobs)  # arms interleaved, so a slow or limited stretch hits all three alike
    claude = Claude(a.run / "claude", a.run / "calls-answer.jsonl", a.slots)

    def one(job: tuple) -> dict:
        arm, c, qid, n, prompt = job
        r = claude.ask("", prompt, effort="medium", tag=f"answer {arm} {c} {qid}")
        text = r["text"]
        ans = text.rsplit("ANSWER:", 1)[-1].strip() if "ANSWER:" in text else text
        return {"arm": arm, "cutoff": c, "qid": qid, "memories": n, "prompt": sha(prompt), "tokens_in": tokens_in(r),
                "answer": ans}

    print(f"{len(jobs)} answers to make, {len(done)} already made", flush=True)
    run_all(jobs, one, a.out / "answers.jsonl", a.slots)


def judge(a: argparse.Namespace) -> None:
    data, answers = load(LOCOMO / "data" / "locomo10.json"), all_answers(a.run, a.out)
    key_path = a.out / "judge_key.json"
    if not key_path.exists():
        items = sorted(answers)
        random.Random(7).shuffle(items)
        key = {f"j{i:05d}": {"arm": arm, "cutoff": c, "qid": qid, "sha": sha(answers[(arm, c, qid)]["answer"])}
               for i, (arm, c, qid) in enumerate(items)}
        key_path.write_text(json.dumps(key, indent=0), encoding="utf-8")
    key = judge_key(a.out, answers)
    prompts = judge_prompts(key, answers, data)
    done = verdicts_on_file(a.out, prompts)
    jobs = [(jid, prompts[jid]) for jid in key if jid not in done]
    claude = Claude(a.run / "claude", a.run / "calls-judge.jsonl", a.slots)

    def one(job: tuple) -> dict:
        jid, prompt = job
        for _ in range(3):  # three replies in all: without want_json, ask() never asks again on its own
            v = verdict(claude.ask(JUDGE_SYSTEM_PROMPT, prompt, effort="medium", tag=f"judge {jid}")["text"])
            if v:
                return {"id": jid, "prompt": sha(prompt), **v}
        raise RuntimeError("no CORRECT or WRONG label in 3 replies")

    print(f"{len(jobs)} verdicts to get, {len(done)} already in", flush=True)
    run_all(jobs, one, a.out / "verdicts.jsonl", a.slots)


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
    check_gate(a.run)
    data, sample, answers = load(LOCOMO / "data" / "locomo10.json"), load(SAMPLE), all_answers(a.run, a.out)
    key = judge_key(a.out, answers)
    verdicts = verdicts_on_file(a.out, judge_prompts(key, answers, data))
    if set(verdicts) != set(key):
        sys.exit(f"{len(verdicts)} verdicts for {len(key)} keyed answers; never scored partial")
    metric = {"F1": f1_scores(answers, data),
              "judge": {(k["arm"], k["cutoff"], k["qid"]): float(verdicts[j]["label"] == "CORRECT") for j, k in key.items()}}
    lines = [f"answers {len(answers)}, verdicts {len(verdicts)}"]
    for c in CUTOFFS:
        lines.append(f"\n=== top {c} ===")
        for arm in ARMS:
            rs = [answers[(arm, c, q)] for q in sample]
            means = "  ".join(f"{m} {100 * sum(metric[m][(arm, c, q)] for q in sample) / len(sample):5.1f}" for m in metric)
            lines.append(f"{arm:>9}  n={len(rs)}  {means}  memories {sum(r['memories'] for r in rs) / len(rs):6.1f}"
                         f"  input tokens {sum(r['tokens_in'] for r in rs) / len(rs):7.0f}")
        for x, y in (("hippo365", "mem0"), ("bm25", "mem0"), ("hippo365", "bm25")):
            for m, vals in metric.items():
                cats = [(None, sample)] + [(k, [q for q in sample if qa_of(data, q)["category"] == k]) for k in CAT]
                for cat, ids in cats:
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
