"""MEME (arXiv 2605.12477) as its main-table runner runs a memory system, over hippo's retrieval
(docs/evals/notes-2026-11-17-meme-triggerbench.md).

MEME-public cb8164d8, imported by meme_vendor.py; meme_filler32k.json at HF revision e14c4e68. Per episode one store:
the sessions up to the before-questions go in turn by turn, those questions retrieve, the change sessions go in, the
after-questions retrieve (run_agent.run_episode). Each question gets hippo's top 20 (Table 2's Mem0 row) as the Mem0
wrapper's "[score=..] memory" lines in UNIFIED_ANSWER_PROMPT, one gpt-4.1-mini answer at temperature 0 and max_tokens
500; judge.py's GPT-4o prompts and trivial-pass rule grade it. Score: Table 2's six task accuracies and their mean.
Usage (runner venv): python -I meme_hippo.py {ingest,retrieve,answer,judge,score,estimate}
  [--arm hippo-emb|bm25] [--smoke] [--slots 8] [--shards 2] [--port-base 9801]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from statistics import mean

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]
import meme_vendor as v  # noqa: E402
from qa import harness  # noqa: E402
from qa.harness import pred_path, sha_bytes  # noqa: E402
from qa.ledger import Item, Ledger, exhausted_lines, one_writer, require, smoke_excluded, unsettled  # noqa: E402
from qa.openai_llm import PRICES, OpenAIChat, free_caps  # noqa: E402
from server_arms import SERVER_ARM  # noqa: E402

NAME = "MEME"
TOPK = v.TOPK
OUT = Path.home() / "hippo-bench" / "results-r2" / "meme"
SMOKE = ("pl_001-b3", "pl_001-a4", "pl_001-a6", "pl_001-a0", "pl_001-a5")  # Del before and after, ER, Tr, Agg


class Run:
    smoke: bool = False


def fed(ep: dict) -> tuple[int, int]:
    """Sessions fed before the before-questions and before the after-questions (run_episode's two positions)."""
    return ep["before_questions"]["position_after_session"] + 1, ep["after_questions"]["position_after_session"] + 1


def turns_of(ep: dict, upto: int) -> list[dict]:
    """Each turn of the first `upto` sessions, dated with its session; hippo stores a message as "<role>: <content>"."""
    return [{"role": t["role"], "content": t["content"], "timestamp": v.epoch(s["timestamp"])}
            for s in ep["sessions"][:upto] for t in s["conversation"]]


def all_questions() -> list[dict]:
    out = []
    for ep in v.episodes():
        before, after = fed(ep)
        for phase, upto in (("before", before), ("after", after)):
            n = len(turns_of(ep, upto))
            for i, q in enumerate(ep[f"{phase}_questions"]["questions"]):
                out.append({"qid": f"{ep['episode_id']}-{phase[0]}{i}", "user_id": f"meme-{ep['episode_id']}",
                            "question": q["question"], "ask_after": n, "episode": ep["episode_id"], "phase": phase,
                            "index": i, "task": q["task_type"].split(" (")[0]})
    return out


def questions() -> list[dict]:
    qs = all_questions()
    return [q for q in qs if q["qid"] in SMOKE] if Run.smoke else qs


def conversations():
    """Each episode's store holds the sessions run_episode feeds: up to the after-questions' position."""
    want = {q["episode"] for q in questions()}
    for ep in v.episodes():
        if ep["episode_id"] in want:
            yield f"meme-{ep['episode_id']}", turns_of(ep, fed(ep)[1])


def hits(out: Path, arm: str, qid: str) -> list[dict]:
    raw = pred_path(out, arm, qid).read_bytes()
    if sha_bytes(raw) != json.loads((out / "predicted" / "manifest.json").read_text(encoding="utf-8"))[arm][qid]:
        sys.exit(f"predicted file for {arm} {qid} differs from its manifest")
    return [{"memory": r["memory"], "score": r["score"]} for r in json.loads(raw)["results"]]


def answer_items(out: Path, arm: str, qs: list[dict]) -> dict[str, Item]:
    return {q["qid"]: Item(f"meme answer {arm} {q['qid']}", "", v.prompt(v.context(hits(out, arm, q["qid"])),
                                                                           q["question"]), v.A_MAN) for q in qs}


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


def agent_output(ep: dict, qs: list[dict], answers: dict) -> dict:
    """run_episode's output for the judge: each asked question with its answer (base.py strips the reply)."""
    out = {"episode_id": ep["episode_id"], "before_answers": [], "after_answers": []}
    for q in qs:
        a = answers[q["qid"]]
        out[f"{q['phase']}_answers"].append({**ep[f"{q['phase']}_questions"]["questions"][q["index"]], "qid": q["qid"],
                                             "agent_answer": a.value.strip() if a.status == "valid" else ""})
    return out


def judged(out: Path, arm: str, qs: list[dict], live: bool, slots: int) -> dict:
    """judge.py's judge_episode per episode, its GPT-4o calls through the ledger; stops while any is unsettled."""
    answers, log = settled_answers(out, arm, qs), out / "calls-judge.jsonl"
    ledger, llm = Ledger(log), OpenAIChat(log, v.JUDGE, slots=slots) if live else None
    if llm:
        require(llm, v.J_MAN)
    by_ep, res, missing = {}, {}, []
    for q in qs:
        by_ep.setdefault(q["episode"], []).append(q)
    eps = {ep["episode_id"]: ep for ep in v.episodes()}

    def one(ep_id: str):
        client = v.LedgerClient(ledger, llm, f"meme judge {arm} {ep_id}")
        try:
            r = v.code().judge.judge_episode(agent_output(eps[ep_id], by_ep[ep_id], answers),
                                             v.code().judge.LLMJudge(client, model="gpt-4o"), max_workers=4)
        except v.NoReply:
            r = None
        return ep_id, r, client.open

    with ThreadPoolExecutor(max(1, slots // 4)) as pool:
        for ep_id, r, opened in pool.map(one, by_ep):
            res[ep_id] = r
            missing += [ep_id] if r is None else []
            if live and r is not None:
                (out / "judge").mkdir(exist_ok=True)
                (out / "judge" / f"{ep_id}.json").write_text(json.dumps(r, indent=1, ensure_ascii=False), "utf-8")
    if missing:
        sys.exit(f"judge: {len(missing)} episodes have a judge call with no valid reply, e.g. {missing[0]}; "
                 "run the judge stage again, and if it stays, read calls-judge.jsonl")
    return res


def task_scores(res: dict, keep: set[str]) -> dict[str, tuple[int, int]]:
    """Table 2: ER, Agg and Tr by the after answer's pass; Cas, Abs and Del only as a real pass (judge_episode)."""
    got: dict[str, list[int]] = {t: [0, 0] for t in v.TASKS}
    for r in res.values():
        for a in r["after_answers"]:
            if a["qid"] in keep:
                t = a["task_type"].split(" (")[0]
                got[t][0] += a.get("pass_type") == "real" if t in v.FILTERED else bool(a.get("u_pass"))
                got[t][1] += 1
    return {t: (p, n) for t, (p, n) in got.items()}


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
    keep = set(every) if Run.smoke else set(every) - smoke_excluded("meme", every)
    s = task_scores(res, keep)
    trivial = Counter(a.get("pass_type") for r in res.values() for a in r["after_answers"]
                      if a["qid"] in keep and a["task_type"].split(" (")[0] in v.FILTERED)
    if Run.smoke:
        lines = [f"SMOKE {NAME}, {arm}: integrity only, never scored or read",
                 *(f"{t}: {n} after-question(s) judged" for t, (_, n) in s.items() if n),
                 f"before-questions judged: {sum(len(r['before_answers']) for r in res.values())}"]
    else:
        acc = {t: p / n for t, (p, n) in s.items() if n}
        lines = [f"{NAME} filler32k as run_main_experiment.sh runs it, {arm}: top {TOPK}, gpt-4.1-mini answers, "
                 f"gpt-4o judge (MEME {v.COMMIT[:8]}; smoke items left out)",
                 *(f"{t:<4} {acc[t]:.2f}  {p}/{n}" for t, (p, n) in s.items() if n),
                 f"Overall {mean(acc.values()):.2f} (unweighted mean of the six)", f"pass types {dict(trivial)}"]
    for stage, log in (("answers", "calls-answer.jsonl"), ("judge", "calls-judge.jsonl")):
        n, pin, pout = ok_usage([out / log])
        lines.append(f"{stage}: {n} calls, {pin} in, {pout} out")
    lines += exhausted_lines(settled_answers(out, arm, qs), "answers")
    (out / ("smoke.txt" if Run.smoke else "score.txt")).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def estimate(arm: str) -> None:
    """The full run's tokens from the smoke's calls: answers by its mean context per hit, judges by its mean call."""
    import tiktoken
    enc, smoke = tiktoken.get_encoding("o200k_base"), OUT / "smoke" / arm
    recs = {k: [json.loads(x) for x in (smoke / f"calls-{k}.jsonl").read_text(encoding="utf-8").splitlines()
                if json.loads(x).get("event") == "ok"] for k in ("answer", "judge")}
    if not recs["answer"] or not recs["judge"]:
        sys.exit(f"{smoke} holds no settled smoke answers or judge calls: run the smoke first")
    tok = lambda s: len(enc.encode(s, disallowed_special=()))  # noqa: E731
    Run.smoke = True
    sq = questions()
    per_hit = mean(tok(f"[score=0.00] {h['memory']}") + 1 for q in sq for h in hits(smoke, arm, q["qid"]))
    frame = tok(v.prompt("", "")) + 8 + 16
    qs = all_questions()
    longest = {e["episode_id"]: sum(sorted((tok(f"[score=0.00] {t['role']}: {t['content'].strip()}") + 1
                                            for t in turns_of(e, fed(e)[1])), reverse=True)[:TOPK])
               for e in v.episodes()}
    a_out = mean(r["usage"]["completion_tokens"] for r in recs["answer"])
    a_in = sum(frame + tok(q["question"]) + TOPK * per_hit for q in qs)
    worst = sum(frame + tok(q["question"]) + longest[q["episode"]] + v.ANSWERER.max_tokens for q in qs)
    j_calls = sum(1 for q in qs if q["task"] != "ER")  # ER is a substring match; every other answer is one call
    j_in, j_out = (mean(r["usage"][k] for r in recs["judge"]) for k in ("prompt_tokens", "completion_tokens"))
    small, big = free_caps()["small"], free_caps()["big"]
    a_tot, j_tot = a_in + len(qs) * a_out, j_calls * (j_in + j_out)
    usd = ((a_in * PRICES[v.MINI][0] + len(qs) * a_out * PRICES[v.MINI][1])
           + j_calls * (j_in * PRICES[v.FOUR_O][0] + j_out * PRICES[v.FOUR_O][1])) / 1e6
    lines = [f"smoke: {len(recs['answer'])} answers, {per_hit:.0f} tokens per hit, {a_out:.0f} out; "
             f"{len(recs['judge'])} judge calls, {j_in:.0f} in, {j_out:.0f} out",
             f"answers ({v.MINI}, small pool): {len(qs)} calls, {a_tot / 1e6:.2f}M tokens = "
             f"{a_tot / small:.1f} free days of {small:,}; worst case (top {TOPK} longest turns, "
             f"{v.ANSWERER.max_tokens} out) {worst / 1e6:.2f}M",
             f"judge ({v.FOUR_O}, big pool): {j_calls} calls, {j_tot / 1e6:.2f}M tokens = {j_tot / big:.1f} free days "
             f"of {big:,}", f"list price: ${usd:.2f}; both snapshots shut down 2027-01-14 (OpenAI deprecations page)"]
    (OUT / "smoke" / "estimate.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def setup(stage: str, out: Path, arm: str) -> list[dict]:
    qs, qfile = questions(), out / "questions.json"
    if stage == "ingest":
        if qfile.exists() and json.loads(qfile.read_text(encoding="utf-8"))["qids"] != [q["qid"] for q in qs]:
            sys.exit(f"{qfile} holds another question set; use a new folder")
        repo = HERE.parents[2]
        cfg = {"lane": "meme, notes-2026-11-17-meme-triggerbench.md", "arm": arm, "topk": TOPK, "smoke": Run.smoke,
               "meme_commit": v.COMMIT, "blobs": v.BLOBS, "hf_revision": v.HF_REVISION, "data_sha256": v.DATA_SHA256,
               "answerer": [v.MINI, v.ANSWERER.cli], "judge": [v.FOUR_O, v.JUDGE.cli],
               "hippo_memory": json.loads((repo / "package.json").read_text(encoding="utf-8"))["version"],
               "repo_head": subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True,
                                           text=True, check=True).stdout.strip(),
               "script_sha256": sha_bytes(Path(__file__).read_bytes()),
               "vendor_sha256": sha_bytes((HERE / "meme_vendor.py").read_bytes())}
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
    ap.add_argument("--smoke", action="store_true", help="five questions of episode pl_001 (SMOKE)")
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--shards", type=int, default=2)
    ap.add_argument("--port-base", type=int, default=9801)
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
