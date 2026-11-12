"""LoCoMo head-to-head with Mem0 (prereg Amendments 4 to 6): answer, judge and score three arms on the Lane A sample.

Prompts and parsing are Mem0's runner's at 4b61c5d (run.py:529-556), one `claude -p` call each through claude_llm.py.
Judge: Claude (primary) or `--judge codex` (secondary, gpt-5.6-sol through qa/codex_judge.py), each with its own files.
Judge and score take every answer and verdict from the call logs through qa/ledger.py, never from answers.jsonl or
verdicts*.jsonl, which only record each run for people.
Usage: python h2h.py {answer,judge,score} --run SCRATCH_DIR --out RESULTS_DIR [--slots 10] [--judge codex]
  [--bonferroni K]
Smoke only: --limit N [--cutoff C] needs an --out path with a "smoke" folder, and keeps the call logs under --out.
Extra arm (dated notes 5): --arm hippo-emb --pairs-with RUN OUT, in its own --run and --out with its own blind key; score
adds the arm minus each registered arm of RUN and OUT, re-made from that run's call logs, all secondary. hippo-best (dated
notes 9) is answered at 50 and 10 alone: at 200 it shows hippo-emb's memories. --also-pairs-with ARM RUN OUT adds the
lines against an extra-arm run, as hippo-best against hippo-emb.
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
RETRIEVAL = Path.home() / "hippo-bench" / "retrieval-v3-locomo"  # hippo 3.5.1 retrieval (Amendment 6 rev. 1 item 1)
RETRIEVAL_OF = {"hippo-emb": Path.home() / "hippo-bench" / "retrieval-emb-locomo",  # extra arms (dated notes 5 and 9)
                "hippo-best": Path.home() / "hippo-bench" / "retrieval-best-locomo"}
ARM_CUTOFFS = {"hippo-best": (50, 10)}
SAMPLE = HERE.parent / "results" / "2026-09-25-lane-a" / "locomo" / "sample.json"
ARMS, CUTOFFS, LABELS = ("hippo365", "bm25", "mem0"), (200, 50, 10), ("CORRECT", "WRONG")
INGEST = {"mem0": "ingest"}  # the Mem0 arm's ingestion under --run, gated
PAIRS = (("hippo365", "mem0"), ("bm25", "mem0"), ("hippo365", "bm25"))
JUDGES = {"claude": ("verdicts.jsonl", "calls-judge.jsonl"), "codex": ("verdicts-codex.jsonl", "calls-judge-codex.jsonl")}
FENCE = re.compile(r"```[a-zA-Z0-9]*\n([\s\S]*?)\n```")  # a whole-reply code fence, as claude_llm.json_reply reads it
CAT = {1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop"}

sys.path[:0] = [str(HERE), str(HERE.parent), str(RUNNER)]
from benchmarks.locomo.prompts import (JUDGE_SYSTEM_PROMPT, get_answer_generation_prompt,  # noqa: E402
                                       get_judge_prompt, preprocess_answer)
from claude_llm import Claude  # noqa: E402
from evidence_recall import bonferroni, cluster_boot  # noqa: E402
from gate import fingerprint  # noqa: E402
from qa.ledger import (ANSWERER, JUDGE, Item, Ledger, exhausted_lines, require, smoke_excluded, trail,  # noqa: E402
                       unsettled)


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


def answer_of(text: str) -> str:
    """The runner's answer parse: the text after the last ANSWER:, else the whole reply."""
    return text.rsplit("ANSWER:", 1)[-1].strip() if "ANSWER:" in text else text


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
    d = (run / INGEST[arm] / "predicted_locomo-mem0" if arm in INGEST
         else RETRIEVAL_OF.get(arm, RETRIEVAL) / f"predicted_locomo-{arm}")
    return load(d / f"{qid}.json")


def tokens_in(rec: dict) -> int:
    u = rec.get("usage") or {}
    return sum(u.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))


def check_gate(run: Path, arms: tuple[str, ...] = ARMS) -> None:
    """Each arm's retrieval folder still matches its manifest, and Mem0's ingestion has a passing gate for its files."""
    for folder in sorted({RETRIEVAL_OF.get(arm, RETRIEVAL) for arm in arms if arm not in INGEST}):
        manifest = folder / "MANIFEST-locomo.sha256"
        if not manifest.is_file():
            sys.exit(f"{folder.name} has no {manifest.name}")
        for line in manifest.read_text(encoding="utf-8").splitlines():
            digest, rel = line.split("  ", 1)
            if not (folder / rel).is_file() or hashlib.sha256((folder / rel).read_bytes()).hexdigest() != digest:
                sys.exit(f"{rel} in {folder.name} is missing or differs from {manifest.name}")
    for name in (INGEST[arm] for arm in arms if arm in INGEST):
        ingest = run / name
        g = load(ingest / "gate.json") if (ingest / "gate.json").exists() else {}
        if not g.get("pass") or g.get("fingerprint") != fingerprint(ingest):
            sys.exit(f"Mem0's ingestion in {name} has no passing gate for its current files; run gate.py --ingest {name} "
                     f"first (prereg Amendments 5 and 6)")


def answer_prompts(a: argparse.Namespace) -> dict:
    """Every answer prompt the design calls for, by (arm, cutoff, qid): how many memories it shows and its log item."""
    prompts = {}
    for arm in a.arms:
        for qid in a.qids:
            q = predicted(a.run, arm, qid)
            for c in a.cutoffs:
                hits = q["retrieval"]["search_results"][:c]
                prompt = get_answer_generation_prompt(q["question"], hits, reference_date=q.get("reference_date"),
                                                      user_profile=q.get("user_profile"))
                prompts[(arm, c, qid)] = (len(hits), Item(f"answer {arm} {c} {qid}", "", prompt, ANSWERER, answer_of))
    return prompts


def all_answers(a: argparse.Namespace) -> dict:
    """Every design answer as its call log settles it, or stop while one still has asks left. An exhausted answer
    holds None and scores wrong."""
    ledger, answers = Ledger(a.logs / "calls-answer.jsonl"), {}
    for k, (n, item) in answer_prompts(a).items():
        c = ledger.choose(item)
        answers[k] = {"answer": c.value, "memories": n, "tokens_in": tokens_in(c.record or {}), "choice": c}
    unsettled({k: r["choice"] for k, r in answers.items()}, "answers")
    return answers


def judge_key(out: Path, answers: dict) -> dict:
    """The blind key, checked to map one to one onto the valid answers as they are now."""
    key, valid = load(out / "judge_key.json"), {k: r["answer"] for k, r in answers.items() if r["answer"] is not None}
    items = {(k["arm"], k["cutoff"], k["qid"]): k["sha"] for k in key.values()}
    if len(items) != len(key) or set(items) != set(valid) or any(s != sha(valid[i]) for i, s in items.items()):
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


def judge_items(key: dict, answers: dict, data: list, judge: str) -> dict:
    """Each keyed answer's judge prompt as a log item: the question, LoCoMo's answer as the runner prepares it, and the
    answer, under the judge's manifest."""
    items = {}
    for jid, k in key.items():
        qa = qa_of(data, k["qid"])
        gold = preprocess_answer(qa["category"], str(qa["answer"]))
        prompt = get_judge_prompt(qa["category"], qa["question"], gold, answers[(k["arm"], k["cutoff"], k["qid"])]["answer"])
        items[jid] = Item(f"judge {jid}", JUDGE_SYSTEM_PROMPT, prompt, JUDGE if judge == "codex" else ANSWERER, verdict)
    return items


def judge_scores(a: argparse.Namespace, judge: str, key: dict, answers: dict, data: list) -> tuple[dict, dict]:
    """One judge's score per design answer from its call log: 1 for CORRECT; 0 for WRONG, for an exhausted verdict and
    for an exhausted answer, which has nothing to judge. Stops while a verdict still has asks left."""
    ledger = Ledger(a.logs / JUDGES[judge][1])
    choices = {jid: ledger.choose(item) for jid, item in judge_items(key, answers, data, judge).items()}
    unsettled(choices, f"{judge} verdicts")
    vals = {k: 0.0 for k in answers}
    for jid, c in choices.items():
        if c.status == "valid":
            vals[(key[jid]["arm"], key[jid]["cutoff"], key[jid]["qid"])] = float(c.value["label"] == "CORRECT")
    return vals, choices


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
    """Asks each design answer that has no valid reply in the log, up to its 3rd ask counted across every run."""
    check_gate(a.run, a.arms)
    prompts, ledger = answer_prompts(a), Ledger(a.logs / "calls-answer.jsonl")
    got = {k: ledger.choose(item) for k, (_, item) in prompts.items()}
    jobs = [(*k, prompts[k][1]) for k, c in got.items() if c.status == "open"]
    random.Random(4).shuffle(jobs)  # arms interleaved, so a slow or limited stretch hits every arm alike
    print(f"{len(jobs)} answers to ask, {sum(c.status == 'valid' for c in got.values())} valid in the log", flush=True)
    print("\n".join(exhausted_lines(got, "answers")), flush=True)
    if not jobs:
        return
    claude = Claude(a.logs / "claude", a.logs / "calls-answer.jsonl", a.slots)
    require(claude, ANSWERER)

    def one(job: tuple) -> dict:
        arm, c, qid, item = job
        ch = ledger.settle(item, claude)
        return {"arm": arm, "cutoff": c, "qid": qid, "memories": prompts[(arm, c, qid)][0], "prompt": sha(item.user),
                "tokens_in": tokens_in(ch.record or {}), "answer": ch.value, **trail(ch)}

    run_all(jobs, one, a.out / "answers.jsonl", a.slots)


def judge(a: argparse.Namespace) -> None:
    """Asks each keyed answer's verdict that has no valid reply in the log, up to its 3rd ask across every run."""
    data, answers = load(LOCOMO / "data" / "locomo10.json"), all_answers(a)
    key_path = a.out / "judge_key.json"
    if not key_path.exists():
        items = sorted(k for k, r in answers.items() if r["answer"] is not None)
        random.Random(7).shuffle(items)
        key = {f"j{i:05d}": {"arm": arm, "cutoff": c, "qid": qid, "sha": sha(answers[(arm, c, qid)]["answer"])}
               for i, (arm, c, qid) in enumerate(items)}
        tmp = key_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(key, indent=0), encoding="utf-8")
        tmp.replace(key_path)  # whole or absent: a kill mid-write never leaves half a key
    key = judge_key(a.out, answers)
    items, log = judge_items(key, answers, data, a.judge), a.logs / JUDGES[a.judge][1]
    ledger = Ledger(log)
    got = {jid: ledger.choose(item) for jid, item in items.items()}
    jobs = [(jid, items[jid]) for jid, c in got.items() if c.status == "open"]
    print(f"{len(jobs)} verdicts to ask, {sum(c.status == 'valid' for c in got.values())} valid in the log", flush=True)
    print("\n".join(exhausted_lines(got, "verdicts")), flush=True)
    if not jobs:
        return
    if a.judge == "codex":
        from qa.codex_judge import CodexJudge  # gpt-5.6-sol at medium through codex exec; read once, so smoke can pass first
        llm, manifest = CodexJudge(log=log, slots=a.slots), JUDGE
    else:
        llm, manifest = Claude(a.logs / "claude", log, a.slots), ANSWERER
    require(llm, manifest)

    def one(job: tuple) -> dict:
        jid, item = job
        ch = ledger.settle(item, llm)
        return {"id": jid, "prompt": sha(item.user), **(ch.value or {}), **trail(ch)}

    run_all(jobs, one, a.out / JUDGES[a.judge][0], a.slots)


def reading(d: float, lo: float, hi: float) -> str:
    """Amendment 2's rule, checked in its order."""
    if lo > 0 and d >= 0.03:
        return "beats"
    if hi < 0 and d <= -0.03:
        return "trails"
    if lo >= -0.03 and hi <= 0.03:
        return "matches"
    return "unresolved"


def by_unit(diff: dict, ids: list, unit_of, level: float = 0.95) -> tuple[float, float, float, int]:
    """The mean of paired differences, its interval over the unit that owns a store, and how many units there are."""
    units: dict = {}
    for i in ids:
        units.setdefault(unit_of(i), []).append(diff[i])
    return (*cluster_boot(units, level=level), len(units))


def paired(diff: dict, ids: list, unit_of, level: float = 0.95) -> str:
    """by_unit as a score line, with Amendment 2's reading."""
    d, lo, hi, n = by_unit(diff, ids, unit_of, level)
    return f"{100 * d:+5.1f} pp [{100 * lo:+5.1f}, {100 * hi:+5.1f}] n={len(ids)} over {n} units  {reading(d, lo, hi)}"


def primary_lines(label: str, diff: dict, primary: list, everyone: list, unit_of, k: int | None) -> list[str]:
    """A primary as every score stage prints it (prereg Amendment 6 revision 1 items 4, 9 and 10): smoke items left
    out, then the all-items line, then with --bonferroni k the interval at 1 - 0.05/k."""
    out = [f"PRIMARY {label}: {paired(diff, primary, unit_of)}",
           f"  secondary, all items with the smoke items: {paired(diff, everyone, unit_of)}"]
    if k:
        out.append(f"  Bonferroni k={k}, {100 * bonferroni(k):.2f}% interval: "
                   f"{paired(diff, primary, unit_of, bonferroni(k))}")
    return out


def f1_scores(answers: dict, data: list) -> dict:
    sys.modules.setdefault("bert_score", types.SimpleNamespace(score=None))  # evaluation.py imports it, F1 never uses it
    sys.path.insert(0, str(LOCOMO / "task_eval"))
    import evaluation as ev
    out = {}
    with contextlib.redirect_stdout(io.StringIO()):
        for (arm, c, qid), r in answers.items():
            if r["answer"] is None:  # exhausted: scores wrong
                out[(arm, c, qid)] = 0.0
                continue
            qa = qa_of(data, qid)
            row = {"answer": qa["answer"], "category": qa["category"], "prediction": r["answer"], "evidence": []}
            out[(arm, c, qid)] = float(ev.eval_question_answering([row], "prediction")[0][0])
    return out


def score(a: argparse.Namespace) -> None:
    """F1 and both judges per arm, the primary without the smoke items (dated notes 1), every exhausted item listed."""
    check_gate(a.run, a.arms)
    data, sample, answers = load(LOCOMO / "data" / "locomo10.json"), a.qids, all_answers(a)
    key = judge_key(a.out, answers)
    smoke = set() if a.limit else smoke_excluded("locomo", load(SAMPLE))  # a smoke run is never scored
    primary = [q for q in sample if q not in smoke]
    metric, lines = {"F1": f1_scores(answers, data)}, [f"answers {len(answers)}, primary questions {len(primary)}"]
    listed = exhausted_lines({k: r["choice"] for k, r in answers.items()}, "answers")
    if a.limit:
        lines.insert(0, f"SMOKE: first {a.limit} questions, cutoffs {a.cutoffs}; never scored or reused")
    for judge, name in (("claude", "judge"), ("codex", "judge2")):  # judge2 is the secondary, run only if its log exists
        if judge == "codex" and not (a.logs / JUDGES[judge][1]).exists():
            lines.append("judge2 (codex gpt-5.6-sol, secondary): not run")
            continue
        metric[name], choices = judge_scores(a, judge, key, answers, data)
        listed += exhausted_lines(choices, f"{name} verdicts")
        lines.append(f"{name} = {'Claude Sonnet 5, the registered judge' if judge == 'claude' else 'codex gpt-5.6-sol'}, secondary: "
                     f"{sum(c.status == 'valid' for c in choices.values())} valid verdicts of {len(choices)}")
    for c in a.cutoffs:
        lines += [f"\n=== top {c} ==="] + [arm_line(answers, metric, arm, c, primary) for arm in a.arms]
        for x, y in () if a.arm else PAIRS:
            for m, vals in metric.items():
                cats = [(None, primary)] + [(k, [q for q in primary if qa_of(data, q)["category"] == k]) for k in CAT]
                for cat, ids in cats:
                    if not ids or (cat and m != "F1"):
                        continue
                    diff, label = {q: vals[(x, c, q)] - vals[(y, c, q)] for q in sample}, f"{x} - {y} {m:>6}"
                    if (x, y, m, cat) == ("hippo365", "mem0", "F1", None) and c in (200, 50):
                        lines += primary_lines(f"{label} {'all':>11}", diff, primary, sample, str, a.bonferroni)
                        lines.append(f"  sensitivity, conversation unit (dated notes 1): "
                                     f"{paired(diff, primary, lambda q: q.split('_q')[0])}")
                    else:
                        lines.append(f"{label} {CAT.get(cat, 'all'):>11}: {paired(diff, ids, str)}")
    if a.arm:
        lines += pair_lines(a, data, primary, metric)
    lines += ["", f"smoke items left out of every primary: {', '.join(sorted(smoke)) or 'none'}", *listed]
    text = "\n".join(lines)
    (a.out / "score.txt").write_text(text + "\n", encoding="utf-8")
    print(text)


def pair_lines(a: argparse.Namespace, data: list, primary: list, metric: dict) -> list[str]:
    """Dated notes 5 and 9: the extra arm minus each arm of the registered run and of each --also-pairs-with run,
    paired by question, at each of the extra arm's cutoffs and for each metric both runs hold. Each run is re-made from
    its own call logs at its own cutoffs and checked as its own score stage checks it."""
    lines = []
    for run, out, arms, arm in [(*a.pairs_with, ARMS, None), *((Path(r), Path(o), (x,), x) for x, r, o in a.also_pairs_with)]:
        reg = argparse.Namespace(**{**vars(a), "run": run, "out": out, "logs": run, "arms": arms, "arm": arm,
                                    "cutoffs": ARM_CUTOFFS.get(arm, CUTOFFS)})
        check_gate(run, arms)
        answers = all_answers(reg)
        key, theirs = judge_key(out, answers), {"F1": f1_scores(answers, data)}
        for judge, name in (("claude", "judge"), ("codex", "judge2")):
            if name in metric and (run / JUDGES[judge][1]).exists():
                theirs[name] = judge_scores(reg, judge, key, answers, data)[0]
        lines.append(f"\n=== {a.arm} minus each arm of {out.name}, paired by question, all secondary (dated notes 5) ===")
        for c in a.cutoffs:
            for other in arms:
                for m, vals in theirs.items():
                    acc = 100 * sum(vals[(other, c, q)] for q in primary) / len(primary)
                    diff = {q: metric[m][(a.arm, c, q)] - vals[(other, c, q)] for q in a.qids}
                    lines.append(f"top {c:>3} {a.arm} - {other} ({acc:.1f} in {out.name}) {m:>6}: "
                                 f"{paired(diff, primary, str)}")
    return lines


def arm_line(answers: dict, metric: dict, arm: str, c: int, ids: list) -> str:
    rs = [answers[(arm, c, q)] for q in ids]
    toks = [r["tokens_in"] for r in rs if r["answer"] is not None]
    means = "  ".join(f"{m} {100 * sum(metric[m][(arm, c, q)] for q in ids) / len(ids):5.1f}" for m in metric)
    return (f"{arm:>9}  n={len(rs)}  {means}  memories {sum(r['memories'] for r in rs) / len(rs):6.1f}"
            f"  input tokens {sum(toks) / max(1, len(toks)):7.0f}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("answer", "judge", "score"))
    ap.add_argument("--run", type=Path, required=True, help="scratch run dir: Mem0's predicted files, call logs")
    ap.add_argument("--out", type=Path, required=True, help="results dir: answers, judge key, verdicts, score")
    ap.add_argument("--slots", type=int, default=10)
    ap.add_argument("--judge", choices=tuple(JUDGES), default="claude", help="judge stage only: the secondary is codex")
    ap.add_argument("--limit", type=int, help="smoke only: the first N sample questions, into a smoke out dir")
    ap.add_argument("--cutoff", type=int, choices=CUTOFFS, help="smoke only: one cutoff, with --limit")
    ap.add_argument("--bonferroni", type=int, metavar="K", help="score: also each primary's interval at 1 - 0.05/K")
    ap.add_argument("--arm", choices=tuple(RETRIEVAL_OF), help="dated notes 5: one extra arm in its own --run and --out")
    ap.add_argument("--pairs-with", type=Path, nargs=2, metavar=("RUN", "OUT"), default=[],
                    help="the registered run's --run and --out that --arm is paired with")
    ap.add_argument("--also-pairs-with", nargs=3, action="append", default=[], metavar=("ARM", "RUN", "OUT"),
                    help="dated notes 9: an extra-arm run, its --run and --out, that --arm is also paired with")
    a = ap.parse_args()
    if bool(a.arm) != bool(a.pairs_with):
        ap.error("--arm and --pairs-with go together")
    if any(x not in RETRIEVAL_OF or x == a.arm for x, _, _ in a.also_pairs_with) or (a.also_pairs_with and not a.arm):
        ap.error("--also-pairs-with names another extra arm's run, with --arm")
    if a.arm and {a.run.resolve(), a.out.resolve()} & {p.resolve() for p in a.pairs_with}:
        ap.error("--arm runs in its own --run and --out, never in the registered run's")
    a.arms = (a.arm,) if a.arm else ARMS
    if a.bonferroni is not None and (a.stage != "score" or a.bonferroni < 1):
        ap.error("--bonferroni K needs the score stage and K of 1 or more")
    if a.judge != "claude" and a.stage != "judge":
        ap.error("--judge applies to the judge stage; score reads both judges' files")
    if a.cutoff and not a.limit:
        ap.error("--cutoff is for smoke runs and needs --limit")
    if a.limit and (a.limit < 1 or "smoke" not in (p.lower() for p in a.out.resolve().parts)):
        ap.error("--limit is for smoke runs: it needs a positive N and an --out path with a folder named smoke")
    sample = load(SAMPLE)
    a.qids, a.cutoffs = (sample[:a.limit] if a.limit else sample), ((a.cutoff,) if a.cutoff else ARM_CUTOFFS.get(a.arm, CUTOFFS))
    a.logs = a.out if a.limit else a.run  # a smoke run never writes into the real run's call logs
    a.out.mkdir(parents=True, exist_ok=True)
    {"answer": answer, "judge": judge, "score": score}[a.stage](a)


if __name__ == "__main__":
    main()
