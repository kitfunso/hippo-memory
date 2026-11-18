"""MemFail (arXiv 2605.26667) as its four task scripts run a memory system, over hippo's retrieval
(docs/evals/notes-2026-11-17-memfail.md).

ishirgarg/MemFail 61ab3028, imported by vendor.py: each task's seed-42 storage and question conversations, a gpt-5-mini
reply to each storage turn (ungraded, no memories), then the turn's user and assistant messages added to one store per
task as Mem0MemorySystem.finalize_conversation adds them; each question asks the top 5 as "- <memory>" lines in the
graded ConversationHistoryPromptTemplate prompt to gpt-5-mini; the task's analyze_errors.py judges each trace on
gpt-5-mini with the whole store. The score is the share judged "correct", per Figure 1 panel. No competitor arm runs.
Usage (runner venv): python -I memfail_hippo.py {replies,ingest,retrieve,answer,judge,score,estimate}
  [--arm hippo-emb|bm25] [--smoke] [--slots 8] [--shards 2] [--port-base 9501]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]
import vendor as v  # noqa: E402
from qa import harness  # noqa: E402
from qa.harness import pred_path, sha_bytes  # noqa: E402
from qa.ledger import Item, Ledger, Manifest, exhausted_lines, one_writer, require, smoke_excluded, unsettled  # noqa: E402
from qa.openai_llm import OpenAIChat  # noqa: E402
from server_arms import SERVER_ARM  # noqa: E402

NAME = "MemFail"
TOPK = v.TOPK
OUT = Path.home() / "hippo-bench" / "results-r2" / "memfail"
MAN = Manifest(v.SNAPSHOT, v.EFFORT, v.GPT5_MINI.cli)
PERSONA_BATCH = 20  # analyze_errors.py DEFAULT_BATCH_SIZE; personal_retrieval.sh passes no --batch-size
SMOKE_TASK_INDEX = 0  # a smoke asks each task's first question and stores only the facts it needs


class Run:
    base: Path = OUT  # replies are the same for every arm, so they sit above the arm folders
    smoke: bool = False


def dataset() -> dict:
    """Per task: the storage conversations, the question rows and queries, and the facts each question needs."""
    out = {}
    for task in v.TASKS:
        storage, rows, queries = v.chat_dataset(task)
        out[task] = {"storage": storage, "rows": rows, "queries": queries}
    return out


FACTS = {"coexisting": "preference_facts", "long-hop": "facts"}  # else entity_facts, one fact per row


def needed(task: str, row: dict) -> set[str]:
    """The facts a question tests, by the field its judge reads."""
    return set(row[FACTS[task]]) if task in FACTS else {row["entity_facts"][0]}


def plan(data: dict, smoke: bool) -> dict:
    """Per task: (storage conversation index, its facts) stored and the question indices asked."""
    out = {}
    for task, d in data.items():
        if smoke:
            q = [SMOKE_TASK_INDEX]
            want = needed(task, d["rows"][SMOKE_TASK_INDEX])
            convs = [(i, c) for i, c in enumerate(d["storage"]) if want & set(c)]
        else:
            q, convs = list(range(len(d["queries"]))), list(enumerate(d["storage"]))
        out[task] = {"convs": convs, "questions": q}
    return out


def reply_item(task: str, conv: int, turn: int, prompt: str) -> Item:
    return Item(f"mf reply {task} {conv}.{turn}", "", prompt, MAN)


def conversation_replies(task: str, ci: int, facts: list[str], pick) -> dict:
    """One storage conversation's replies in turn order, each prompt over the conversation so far (Evaluator)."""
    out, history = {}, []
    for ti, fact in enumerate(facts):
        c = out[(task, ci, ti)] = pick(reply_item(task, ci, ti, v.prompt(fact, "", history, graded=False)))
        if c.status != "valid":
            break  # the next turn's prompt holds this reply; unsettled() stops before it is needed
        history.append((fact, c.value))
    return out


def storage_convs(data: dict) -> list[tuple[str, int, list[str]]]:
    return [(task, ci, facts) for task, p in plan(data, Run.smoke).items() for ci, facts in p["convs"]]


def replies(data: dict, ledger: Ledger) -> dict:
    return {k: c for task, ci, facts in storage_convs(data)
            for k, c in conversation_replies(task, ci, facts, ledger.choose).items()}


def run_replies(data: dict, slots: int) -> None:
    log = Run.base / "calls-reply.jsonl"
    log.parent.mkdir(parents=True, exist_ok=True)
    ledger, llm = Ledger(log), OpenAIChat(log, v.GPT5_MINI, slots=slots)
    require(llm, MAN)
    convs = storage_convs(data)
    print(f"{len(convs)} storage conversations into {log}", flush=True)
    with ThreadPoolExecutor(slots) as pool:
        list(pool.map(lambda c: conversation_replies(*c, lambda it: ledger.settle(it, llm)), convs))


def settled_replies(data: dict) -> dict:
    got = replies(data, Ledger(Run.base / "calls-reply.jsonl"))
    unsettled(got, "storage replies")
    return got


def conversations():
    """Each task's store: per storage turn the user message, then gpt-5-mini's reply (finalize_conversation's order)."""
    data = DATA()
    got = settled_replies(data)
    for task, p in plan(data, Run.smoke).items():
        turns = []
        for ci, facts in p["convs"]:
            for ti, fact in enumerate(facts):
                reply = got[(task, ci, ti)].value if got[(task, ci, ti)].status == "valid" else ""
                turns += [{"role": "user", "content": fact, "timestamp": None},
                          {"role": "assistant", "content": reply, "timestamp": None}]
        yield f"memfail-{task}", turns


def all_memories(turns: list[dict]) -> list[str]:
    """The store's memories as hippo-mem0-server.mjs addChunk writes one message: "<role>: <content>"."""
    return [f"{t['role']}: {t['content'].strip()}" for t in turns if t["content"].strip()]


def questions() -> list[dict]:
    data = DATA()
    return [{"qid": f"{task}-{i:03d}", "user_id": f"memfail-{task}", "question": data[task]["queries"][i],
             "task": task, "index": i, "ask_after": None}
            for task, p in plan(data, Run.smoke).items() for i in p["questions"]]


_DATA: dict = {}


def DATA() -> dict:  # noqa: N802
    if not _DATA:
        _DATA.update(dataset())
    return _DATA


def memories(out: Path, arm: str, qid: str) -> list[str]:
    raw = pred_path(out, arm, qid).read_bytes()
    if sha_bytes(raw) != json.loads((out / "predicted" / "manifest.json").read_text(encoding="utf-8"))[arm][qid]:
        sys.exit(f"predicted file for {arm} {qid} differs from its manifest")
    return [r["memory"] for r in json.loads(raw)["results"]]


def answer_items(out: Path, arm: str, qs: list[dict]) -> dict[str, Item]:
    return {q["qid"]: Item(f"mf answer {arm} {q['qid']}", "", v.prompt(
        q["question"], v.memories_text(memories(out, arm, q["qid"])), [], graded=True), MAN) for q in qs}


def settled_answers(out: Path, arm: str, qs: list[dict]) -> dict:
    ledger = Ledger(out / "calls-answer.jsonl")
    got = {qid: ledger.choose(it) for qid, it in answer_items(out, arm, qs).items()}
    unsettled(got, "answers")
    return got


def run_answers(out: Path, arm: str, qs: list[dict], slots: int) -> None:
    ledger, llm = Ledger(out / "calls-answer.jsonl"), OpenAIChat(out / "calls-answer.jsonl", v.GPT5_MINI, slots=slots)
    require(llm, MAN)
    todo = answer_items(out, arm, qs)
    with ThreadPoolExecutor(slots) as pool:
        list(pool.map(lambda k: ledger.settle(todo[k], llm), todo))


def stored_check(out: Path, arm: str, user: str, mems: list[str]) -> None:
    done = [json.loads(x) for x in (out / "ingest" / arm / "done.jsonl").read_text(encoding="utf-8").splitlines()]
    stored = [d["stored"] for d in done if d["user"] == user][-1:]
    if stored != [len(mems)]:
        sys.exit(f"{user}: the store holds {stored} memories, the rebuilt list {len(mems)}: no judge on it")


def judge_task(out: Path, arm: str, task: str, qs: list[dict], answers: dict, turns: list[dict], live: bool,
               slots: int) -> tuple[list[dict], v.LedgerClient]:
    """The task's own analyze_errors over its graded traces and the whole store, as its main() calls it."""
    mems = all_memories(turns)
    stored_check(out, arm, f"memfail-{task}", mems)
    traces = []
    for q in qs:
        mtext, a = v.memories_text(memories(out, arm, q["qid"])), answers[q["qid"]]
        traces.append(v.graded_trace(task, DATA()[task]["rows"][q["index"]], q["question"], mtext,
                                     a.value if a.status == "valid" else "",
                                     v.prompt(q["question"], mtext, [], graded=True), (a.record or {}).get("usage") or {}))
    client = v.LedgerClient(out / "judge" / task, f"mf judge {arm} {task}", live, slots, batches=task == "persona")
    mod = v.module(v.TASKS[task].judge)
    if task == "persona":
        mod._sleep_after_error = lambda *a, **k: None  # a retry reads the same ledger reply, so its wait changes nothing
        results, _, _ = mod.analyze_run(client, v.MODEL, traces, mems, PERSONA_BATCH, slots)
    else:
        args = (True,) if v.TASKS[task].hard else ()
        with ThreadPoolExecutor(slots) as pool:
            results = [r for r, _, _ in pool.map(lambda t: mod.analyze_trace(client, v.MODEL, t, mems, *args), traces)]
    return results, client


def judged(out: Path, arm: str, qs: list[dict], live: bool, slots: int) -> dict:
    answers, convs = settled_answers(out, arm, qs), dict(conversations())
    out_by_task, opened = {}, []
    for task in v.TASKS:
        tq = [q for q in qs if q["task"] == task]
        results, client = judge_task(out, arm, task, tq, answers, convs[f"memfail-{task}"], live, slots)
        out_by_task[task], opened = dict(zip([q["qid"] for q in tq], results)), opened + client.open
        if live:
            (out / "judge" / f"{task}.json").write_text(json.dumps(results, indent=1, default=str), encoding="utf-8")
    if opened:
        sys.exit(f"judge: {len(opened)} calls not settled, e.g. {opened[0]}; run the judge stage again")
    return out_by_task


def panels(task: str, results: dict) -> dict[str, list]:
    """Figure 1's panels: persona splits into non-misleading and misleading questions."""
    if task != "persona":
        return {task: list(results)}
    return {f"persona-{k}": [q for q, r in results.items() if (r.get("question_type") == "misleading") == (k == "misleading")]
            for k in ("non-misleading", "misleading")}


def ledger_tokens(paths) -> tuple[int, int, int]:
    """Calls, prompt and completion tokens of every ok record in the logs."""
    n = pin = pout = 0
    for p in paths:
        for line in p.read_text(encoding="utf-8").splitlines() if p.exists() else []:
            r = json.loads(line)
            if r.get("event") == "ok":
                u = r.get("usage") or {}
                n, pin, pout = n + 1, pin + (u.get("prompt_tokens") or 0), pout + (u.get("completion_tokens") or 0)
    return n, pin, pout


def token_lines(out: Path, n: int) -> list[str]:
    lines = []
    for stage, paths in (("replies", [Run.base / "calls-reply.jsonl"]), ("answers", [out / "calls-answer.jsonl"]),
                         ("judge", sorted((out / "judge").rglob("*.jsonl")))):
        calls, pin, pout = ledger_tokens(paths)
        lines.append(f"{stage}: {calls} calls, {pin} in, {pout} out, {(pin + pout) / n:.0f} tokens per question")
    return lines


def score(out: Path, arm: str, qs: list[dict], slots: int) -> None:
    res = judged(out, arm, qs, False, slots)
    rows = []
    every = [q["qid"] for q in qs]
    primary = set(every) if Run.smoke else set(every) - smoke_excluded("memfail", every)
    for task, results in res.items():
        for panel, ids in panels(task, results).items():
            good = sum(results[i]["judge_result"] == "correct" for i in ids)
            errors = Counter(results[i].get("error_type") or ("analysis_error" if results[i].get("analysis_error")
                                                               else "none") for i in ids)
            pgood, pn = sum(results[i]["judge_result"] == "correct" for i in ids if i in primary), \
                sum(i in primary for i in ids)
            rows.append((panel, good, len(ids), pgood, pn, errors))
    if Run.smoke:
        lines = [f"SMOKE {NAME}, {arm}: integrity only, never scored or read"]
        lines += [f"{p}: {n} question(s), judged {sum(e.values())}, analysis errors {e.get('analysis_error', 0)}"
                  for p, _, n, _, _, e in rows]
    else:
        lines = [f"{NAME} as its task scripts run it, {arm}: top {TOPK}, gpt-5-mini answers and judges (MemFail "
                 f"{v.COMMIT[:8]})"]
        lines += [f"{p:<26} {100 * g / n:6.2f}  {g}/{n} all items   {100 * pg / max(pn, 1):6.2f}  {pg}/{pn} primary   "
                  f"{dict(e)}" for p, g, n, pg, pn, e in rows]
    lines += token_lines(out, len(qs)) + exhausted_lines(settled_answers(out, arm, qs), "answers")
    (out / ("smoke.txt" if Run.smoke else "score.txt")).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def setup(stage: str, out: Path, arm: str) -> list[dict]:
    qs, qfile = questions(), out / "questions.json"
    if stage == "ingest":
        if qfile.exists() and json.loads(qfile.read_text(encoding="utf-8"))["qids"] != [q["qid"] for q in qs]:
            sys.exit(f"{qfile} holds another question set; use a new folder")
        repo = HERE.parents[2]
        cfg = {"lane": "memfail, notes-2026-11-17-memfail.md", "arm": arm, "topk": TOPK, "smoke": Run.smoke,
               "memfail_commit": v.COMMIT, "blobs": v.BLOBS, "model": v.SNAPSHOT, "cli": v.GPT5_MINI.cli,
               "hippo_memory": json.loads((repo / "package.json").read_text(encoding="utf-8"))["version"],
               "repo_head": subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True,
                                           text=True, check=True).stdout.strip(),
               "script_sha256": sha_bytes(Path(__file__).read_bytes()),
               "vendor_sha256": sha_bytes((HERE / "vendor.py").read_bytes())}
        out.mkdir(parents=True, exist_ok=True)
        qfile.write_text(json.dumps({"qids": [q["qid"] for q in qs]}), encoding="utf-8")
        (out / "config.json").write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    elif not qfile.exists() or json.loads(qfile.read_text(encoding="utf-8"))["qids"] != [q["qid"] for q in qs]:
        sys.exit(f"{qfile} is missing or holds another question set; run ingest first")
    return qs


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("replies", "ingest", "retrieve", "answer", "judge", "score", "estimate"))
    ap.add_argument("--arm", choices=("hippo-emb", "bm25"), default="hippo-emb")
    ap.add_argument("--smoke", action="store_true", help="each task's first question, over only the facts it needs")
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--shards", type=int, default=2)
    ap.add_argument("--port-base", type=int, default=9501)
    a = ap.parse_args()
    Run.smoke, Run.base = a.smoke, OUT / "smoke" if a.smoke else OUT
    out = Run.base / a.arm
    if a.stage == "estimate":
        import estimate
        return estimate.main(DATA(), OUT / "smoke", a.arm, sys.modules[__name__])
    if a.stage == "replies":
        with one_writer(Run.base):
            return run_replies(DATA(), a.slots)
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
