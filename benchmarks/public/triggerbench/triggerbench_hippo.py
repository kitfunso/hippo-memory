"""TriggerBench (arXiv 2606.23459), Base context, as its Mem0 runner runs a memory system, over hippo's retrieval
(docs/evals/notes-2026-11-17-meme-triggerbench.md).

TriggerBench-Official 9e2185c3, imported by triggerbench_vendor.py: per task one store with every turn before the
trigger, each in _format_turn's "USER [time]: text" form; the formatted trigger retrieves hippo's top 6 (run_mem0.sh);
they go to gpt-4.1 as "- <memory>" lines in _run_one_mem0's messages at temperature 0.6 and max_tokens 1024; the
vendor's _run_judge_batch grades each reply with PMJudge (GPT-4o, temperature 0, few-shot by category) and pm_scorer
gives the slot match. Score: tab:main_results' columns, PM Acc over all 1,265 tasks as Overall.
Usage (runner venv): python -I triggerbench_hippo.py {ingest,retrieve,answer,judge,score,estimate}
  [--arm hippo-emb|bm25] [--smoke] [--slots 8] [--shards 2] [--port-base 9901]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from statistics import mean

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]
import triggerbench_vendor as v  # noqa: E402
from qa import harness  # noqa: E402
from qa.harness import pred_path, sha_bytes  # noqa: E402
from qa.ledger import Item, Ledger, exhausted_lines, one_writer, require, smoke_excluded, unsettled  # noqa: E402
from qa.openai_llm import PRICES, OpenAIChat, free_caps  # noqa: E402
from server_arms import SERVER_ARM  # noqa: E402

NAME = "TriggerBench"
TOPK = v.TOPK
OUT = Path.home() / "hippo-bench" / "results-r2" / "triggerbench"
# the first task of five files: every dimension, both negative judge modes (intent-only and full), both positives
SMOKE = ("tb-pc-seed_02", "tb-po-seed_01_absolute_blind_action", "tb-nc-logical_adherence_001",
         "tb-pc-interrupt_seed_001", "tb-nc-seed_b01")
COLUMNS = ("positive_clean", "positive_overloaded", "negative_clean")


class Run:
    smoke: bool = False


def trigger(e: dict) -> dict:
    s = e["sample"]
    return s["turns"][s["ground_truth"]["trigger"]["trigger_turn_idx"]]


def by_qid() -> dict[str, dict]:
    return {v.qid(e): e for e in v.entries()}


def questions() -> list[dict]:
    out = [{"qid": v.qid(e), "user_id": v.qid(e), "question": v.code().mem0._format_turn(trigger(e)),
            "ask_after": None} for e in v.entries()]
    return [q for q in out if q["qid"] in SMOKE] if Run.smoke else out


def conversations():
    """Each task's store: the turns before its trigger, as _run_one_mem0 hands them to Mem0 (no Base turn reaches its
    2,000-token chunk size, so each turn is one message)."""
    want, fmt = {q["qid"] for q in questions()}, v.code().mem0._format_turn
    for e in v.entries():
        if v.qid(e) in want:
            s = e["sample"]
            yield v.qid(e), [{"role": "user" if t["role"] == "user" else "assistant", "content": fmt(t),
                              "timestamp": v.epoch(t["timestamp"])}
                             for t in s["turns"][:s["ground_truth"]["trigger"]["trigger_turn_idx"]]]


def memories(out: Path, arm: str, qid: str) -> list[str]:
    raw = pred_path(out, arm, qid).read_bytes()
    if sha_bytes(raw) != json.loads((out / "predicted" / "manifest.json").read_text(encoding="utf-8"))[arm][qid]:
        sys.exit(f"predicted file for {arm} {qid} differs from its manifest")
    return [r["memory"] for r in json.loads(raw)["results"] if r["memory"]]


def answer_items(out: Path, arm: str, qs: list[dict]) -> dict[str, Item]:
    es, items = by_qid(), {}
    for q in qs:
        system, user = v.answer_messages(es[q["qid"]]["category"], memories(out, arm, q["qid"]), q["question"])
        items[q["qid"]] = Item(f"tb answer {arm} {q['qid']}", system, user, v.A_MAN)
    return items


def settled_answers(out: Path, arm: str, qs: list[dict]) -> dict:
    ledger = Ledger(out / "calls-answer.jsonl")
    got = {qid: ledger.choose(it) for qid, it in answer_items(out, arm, qs).items()}
    unsettled(got, "answers")
    return got


def run_answers(out: Path, arm: str, qs: list[dict], slots: int) -> None:
    log = out / "calls-answer.jsonl"
    ledger, llm = Ledger(log), OpenAIChat(log, v.ANSWERER, slots=slots)
    require(llm, v.A_MAN)
    todo = answer_items(out, arm, qs)
    with ThreadPoolExecutor(slots) as pool:
        list(pool.map(lambda k: ledger.settle(todo[k], llm), todo))


def judged(out: Path, arm: str, qs: list[dict], live: bool, slots: int) -> list[dict]:
    """mem0_eval's run_pm scoring and judge per (category, variant) file, the reply taken from the answer log."""
    answers, es, c = settled_answers(out, arm, qs), by_qid(), v.code()
    groups: dict[tuple, list] = {}
    for q in qs:
        e = es[q["qid"]]
        a = answers[q["qid"]]
        reply = a.value if a.status == "valid" else "[ERROR: no valid reply in 3 asks]"  # what _run_one_mem0 writes
        r = {**c.scorer.score_to_dict(c.scorer.score_sample(e, reply)), "pm_reply": reply, "qid": q["qid"]}
        groups.setdefault((e["category"], e["variant"]), []).append((r, e))
    client = v.LedgerJudge(out / "judge", f"tb judge {arm}", live, slots)

    def one(key):
        rs, ents = [r for r, _ in groups[key]], [e for _, e in groups[key]]
        js = c.mem0._run_judge_batch(rs, ents, c.judge.PMJudge(client))
        return [{**j, "qid": r["qid"]} for j, r in zip(js, rs)]

    with ThreadPoolExecutor(max(1, min(len(groups), slots))) as pool:
        res = [j for js in pool.map(one, groups) for j in js]
    if client.open:
        sys.exit(f"judge: {len(client.open)} calls not settled, e.g. {client.open[0]}; run the judge stage again")
    if live:
        (out / "judge.jsonl").write_text("".join(json.dumps(j, ensure_ascii=False) + "\n" for j in res), "utf-8")
    return res


def table(res: list[dict]) -> list[str]:
    """tab:main_results' columns: slot match and PM Acc per positive variant, PM Acc on Neg-Clean, both over all
    positives, and PM Acc over every task as Overall (Mem0's row: 348/488, 164/488, 161/289 gives 53.20)."""
    def pm(rows):
        return f"{100 * sum(j['judge_correct'] for j in rows) / len(rows):6.2f} ({sum(j['judge_correct'] for j in rows)}/{len(rows)})"

    def slot(rows):
        return f"{100 * mean(j['rule_based_slot_match'] for j in rows):6.2f}"
    col = {k: [j for j in res if j["variant"] == k] for k in COLUMNS}
    pos = col["positive_clean"] + col["positive_overloaded"]
    lines = [f"{k:<20} slot {slot(col[k])}  PM Acc {pm(col[k])}" for k in COLUMNS[:2] if col[k]]
    lines += [f"negative_clean       PM Acc {pm(col['negative_clean'])}"] if col["negative_clean"] else []
    lines += [f"all positive         slot {slot(pos)}  PM Acc {pm(pos)}"] if pos else []
    lines += [f"overall              PM Acc {pm(res)}",
              *(f"  {cat:<19} PM Acc {pm(rows)}" for cat in v.CATEGORIES
                for rows in [[j for j in res if j["category"] == cat]] if rows),
              f"verdict ERROR (scored wrong): {sum(j['verdict'] == 'ERROR' for j in res)}"]
    return lines


def ok_usage(paths) -> tuple[int, int, int]:
    """Calls, prompt and completion tokens of every ok record in the logs."""
    n = pin = pout = 0
    for p in paths:
        for line in p.read_text(encoding="utf-8").splitlines() if p.exists() else []:
            r = json.loads(line)
            if r.get("event") == "ok":
                u = r.get("usage") or {}
                n, pin, pout = n + 1, pin + (u.get("prompt_tokens") or 0), pout + (u.get("completion_tokens") or 0)
    return n, pin, pout


def score(out: Path, arm: str, qs: list[dict], slots: int) -> None:
    res = judged(out, arm, qs, False, slots)
    every = [q["qid"] for q in qs]
    keep = set(every) if Run.smoke else set(every) - smoke_excluded("triggerbench", every)
    res = [j for j in res if j["qid"] in keep]
    if Run.smoke:
        lines = [f"SMOKE {NAME}, {arm}: integrity only, never scored or read", f"{len(res)} tasks judged, verdicts "
                 f"{sorted((j['variant'], j['verdict']) for j in res)}"]
    else:
        lines = [f"{NAME} Base as run_mem0.sh runs it, {arm}: top {TOPK}, gpt-4.1 at 0.6, gpt-4o judge "
                 f"(TriggerBench {v.COMMIT[:8]}; smoke items left out)", *table(res)]
    for stage, paths in (("answers", [out / "calls-answer.jsonl"]), ("judge", sorted((out / "judge").glob("*.jsonl")))):
        n, pin, pout = ok_usage(paths)
        lines.append(f"{stage}: {n} calls, {pin} in, {pout} out")
    lines += exhausted_lines(settled_answers(out, arm, qs), "answers")
    (out / ("smoke.txt" if Run.smoke else "score.txt")).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def estimate(arm: str) -> None:
    """The full run's big-pool tokens: each answer prompt counted from the data with the smoke's mean tokens per memory,
    replies and judge calls at the smoke's means; the worst case takes the 6 longest turns and 1,024 out."""
    import tiktoken
    enc, smoke = tiktoken.get_encoding("o200k_base"), OUT / "smoke" / arm
    tok = lambda s: len(enc.encode(s, disallowed_special=()))  # noqa: E731
    a = [json.loads(x) for x in (smoke / "calls-answer.jsonl").read_text(encoding="utf-8").splitlines()
         if json.loads(x).get("event") == "ok"] if (smoke / "calls-answer.jsonl").exists() else []
    j = [json.loads(x) for p in sorted((smoke / "judge").glob("*.jsonl")) for x in p.read_text("utf-8").splitlines()
         if json.loads(x).get("event") == "ok"]
    if not a or not j:
        sys.exit(f"{smoke} holds no settled smoke answers or judge calls: run the smoke first")
    Run.smoke = True
    per_mem = mean(tok(f"- {m}") + 1 for q in questions() for m in memories(smoke, arm, q["qid"]))
    Run.smoke = False
    a_out = mean(r["usage"]["completion_tokens"] for r in a)
    j_in, j_out = (mean(r["usage"][k] for r in j) for k in ("prompt_tokens", "completion_tokens"))
    a_in = worst = 0
    turns, es = dict(conversations()), by_qid()
    for q in questions():
        system, frame = v.answer_messages(es[q["qid"]]["category"], [], q["question"])
        base = tok(system) + tok(frame) - tok("(no memories retrieved)") + 2 * 8 + 16
        a_in += base + min(TOPK, len(turns[q["qid"]])) * per_mem
        worst += base + sum(sorted((tok(f"- {t['role']}: {t['content']}") + 1 for t in turns[q["qid"]]),
                                   reverse=True)[:TOPK])
    n = len(questions())
    worst += n * v.ANSWERER.max_tokens
    total = a_in + n * a_out + n * (j_in + j_out)
    usd = (a_in * PRICES[v.GEN][0] + n * a_out * PRICES[v.GEN][1] + n * (j_in * PRICES[v.FOUR_O][0]
                                                                         + j_out * PRICES[v.FOUR_O][1])) / 1e6
    big = free_caps()["big"]
    lines = [f"smoke: {len(a)} answers, {per_mem:.0f} tokens per memory, {a_out:.0f} out; {len(j)} judge calls, "
             f"{j_in:.0f} in, {j_out:.0f} out",
             f"answers ({v.GEN_SNAPSHOT}, big pool): {n} calls, {(a_in + n * a_out) / 1e6:.2f}M tokens; worst case "
             f"{worst / 1e6:.2f}M",
             f"judge ({v.FOUR_O}, big pool): {n} calls, {n * (j_in + j_out) / 1e6:.2f}M tokens",
             f"total {total / 1e6:.2f}M big-pool tokens = {total / big:.1f} free days of {big:,}; list price ${usd:.2f}; "
             "both snapshots shut down 2027-01-14 (OpenAI deprecations page)"]
    (OUT / "smoke" / "estimate.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def setup(stage: str, out: Path, arm: str) -> list[dict]:
    qs, qfile = questions(), out / "questions.json"
    if stage == "ingest":
        if qfile.exists() and json.loads(qfile.read_text(encoding="utf-8"))["qids"] != [q["qid"] for q in qs]:
            sys.exit(f"{qfile} holds another question set; use a new folder")
        repo = HERE.parents[2]
        cfg = {"lane": "triggerbench, notes-2026-11-17-meme-triggerbench.md", "arm": arm, "topk": TOPK,
               "smoke": Run.smoke, "triggerbench_commit": v.COMMIT, "blobs": v.BLOBS,
               "answerer": [v.GEN, v.GEN_SNAPSHOT, v.ANSWERER.cli], "judge": [v.FOUR_O, v.JUDGE_MAX_TOKENS],
               "hippo_memory": json.loads((repo / "package.json").read_text(encoding="utf-8"))["version"],
               "repo_head": subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True,
                                           text=True, check=True).stdout.strip(),
               "script_sha256": sha_bytes(Path(__file__).read_bytes()),
               "vendor_sha256": sha_bytes((HERE / "triggerbench_vendor.py").read_bytes())}
        out.mkdir(parents=True, exist_ok=True)
        qfile.write_text(json.dumps({"qids": [q["qid"] for q in qs]}), encoding="utf-8")
        (out / "config.json").write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    elif not qfile.exists() or json.loads(qfile.read_text(encoding="utf-8"))["qids"] != [q["qid"] for q in qs]:
        sys.exit(f"{qfile} is missing or holds another question set; run ingest first")
    return qs


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("ingest", "retrieve", "answer", "judge", "score", "estimate"))
    ap.add_argument("--arm", choices=("hippo-emb", "bm25"), default="hippo-emb")
    ap.add_argument("--smoke", action="store_true", help="the five tasks of SMOKE")
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--shards", type=int, default=2)
    ap.add_argument("--port-base", type=int, default=9901)
    a = ap.parse_args()
    Run.smoke = a.smoke
    out = (OUT / "smoke" if a.smoke else OUT) / a.arm
    if a.stage == "estimate":
        return estimate(a.arm)
    if a.stage == "score":
        return score(out, a.arm, setup(a.stage, out, a.arm), a.slots)
    with one_writer(out):
        qs = setup(a.stage, out, a.arm)
        if a.stage in ("ingest", "retrieve"):
            ns = argparse.Namespace(out=out, arm=a.arm, arms={a.arm: SERVER_ARM[a.arm]}, store_from=None,
                                    shards=a.shards, port_base=a.port_base, stage=a.stage)
            harness.stage_ingest_retrieve(ns, sys.modules[__name__], qs)
        elif a.stage == "answer":
            run_answers(out, a.arm, qs, a.slots)
        else:
            judged(out, a.arm, qs, True, a.slots)


if __name__ == "__main__":
    main()
