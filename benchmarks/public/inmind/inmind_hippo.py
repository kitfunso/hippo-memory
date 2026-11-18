"""InMind (arXiv 2607.24368) under its stateful middle-injection protocol, over hippo's retrieval
(docs/evals/notes-2026-11-17-inmind.md).

imlrz/InMind 5a2ab268, imported by vendor.py: one hippo store per task, fed the 47 LME-s sessions with the task's
user/assistant pair at the end of session 9 (build_timeline.py); the naive query and the indirect query each search
the same frozen store for the top 10 (Mem0's and A-Mem's top-k in Tables 11 and 12); gpt-5-mini answers on
answer_system.txt and judges each task three times (naive, target recall, application) on the repo's binary judges.
Each metric is the share of the 125 tasks judged 1, as in Table 1. No competitor arm runs.
Usage (runner venv): python -I inmind_hippo.py {ingest,retrieve,answer,judge,score,estimate}
  [--arm hippo-emb|bm25] [--smoke] [--slots 8] [--shards 2] [--port-base 9701]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent)]
from inmind import vendor as v  # noqa: E402
from qa import harness  # noqa: E402
from qa.harness import pred_path, sha_bytes  # noqa: E402
from qa.ledger import Item, Ledger, Manifest, exhausted_lines, one_writer, require, smoke_excluded, unsettled  # noqa: E402
from qa.openai_llm import SPEND  # noqa: E402
from qa.openai_reasoning import ReasoningChat, reply_text  # noqa: E402
from server_arms import SERVER_ARM  # noqa: E402

NAME = "InMind"
TOPK = v.TOPK
OUT = Path.home() / "hippo-bench" / "results-r2" / "inmind"
A_MAN, J_MAN = Manifest(v.SNAPSHOT, v.EFFORT, v.ANSWERER.cli), Manifest(v.SNAPSHOT, v.EFFORT, v.JUDGE.cli)
SMOKE = (0, 31, 62, 93, 124)  # row indices spread over the 125 tasks; their stores are built and searched
SMOKE_ASKED = 1  # of those, the tasks asked of gpt-5-mini: one task's 5 calls fit the 50k-token smoke budget


class Run:
    smoke: bool = False


def picked() -> list[dict]:
    rows = v.tasks()
    return [rows[i] for i in SMOKE] if Run.smoke else list(rows)


def unit(task: dict) -> str:
    """The scored unit, as smoke_excluded.json lists it."""
    return f"task-{task['task_id']}"


def user(task: dict) -> str:
    return f"inmind-{task['task_id']:03d}"


def conversations():
    for t in picked():
        yield user(t), v.timeline(t)


def questions() -> list[dict]:
    return [{"qid": f"{unit(t)}-{kind}", "user_id": user(t), "question": t[field], "ask_after": None,
             "task_id": t["task_id"], "kind": kind}
            for t in picked() for kind, field in (("naive", "naive_query"), ("query", "query"))]


def asked(qs: list[dict]) -> list[dict]:
    """The questions answered and judged: all, or in a smoke the first SMOKE_ASKED tasks'."""
    keep = {q["task_id"] for q in qs[:2 * SMOKE_ASKED]} if Run.smoke else {q["task_id"] for q in qs}
    return [q for q in qs if q["task_id"] in keep]


def memories(out: Path, arm: str, qid: str) -> list[str]:
    raw = pred_path(out, arm, qid).read_bytes()
    if sha_bytes(raw) != json.loads((out / "predicted" / "manifest.json").read_text(encoding="utf-8"))[arm][qid]:
        sys.exit(f"predicted file for {arm} {qid} differs from its manifest")
    return [r["memory"] for r in json.loads(raw)["results"]]


def answer_items(out: Path, arm: str, qs: list[dict]) -> dict[str, Item]:
    return {q["qid"]: Item(f"im answer {arm} {q['qid']}", v.answer_system(v.context(memories(out, arm, q["qid"]))),
                           q["question"], A_MAN) for q in qs}


def settled_answers(out: Path, arm: str, qs: list[dict]) -> dict:
    ledger = Ledger(out / "calls-answer.jsonl")
    got = {qid: ledger.choose(it) for qid, it in answer_items(out, arm, qs).items()}
    unsettled(got, "answers")
    return got


def llm(log: Path, settings, slots: int) -> ReasoningChat:
    """gpt-5-mini on the small free pool; its spend sits with the other small-pool lanes'."""
    return ReasoningChat(log, settings, slots=slots, spend=SPEND)


def run_answers(out: Path, arm: str, qs: list[dict], slots: int) -> None:
    ledger, chat = Ledger(out / "calls-answer.jsonl"), llm(out / "calls-answer.jsonl", v.ANSWERER, slots)
    require(chat, A_MAN)
    todo = answer_items(out, arm, qs)
    with ThreadPoolExecutor(slots) as pool:
        list(pool.map(lambda k: ledger.settle(todo[k], chat), todo))


def results(out: Path, arm: str, qs: list[dict]) -> dict[int, dict]:
    """Per task the submission row's two turns: the exact context shown and the answer (submission.schema.json)."""
    answers, rows = settled_answers(out, arm, qs), {}
    for q in qs:
        a = answers[q["qid"]]
        rows.setdefault(q["task_id"], {})[q["kind"]] = {
            "context": v.context(memories(out, arm, q["qid"])),
            "answer": reply_text(a.value) if a.status == "valid" else ""}
    return rows


def judge_items(out: Path, arm: str, qs: list[dict]) -> dict[tuple[int, str], Item]:
    by_id = {t["task_id"]: t for t in v.tasks()}
    return {(tid, m): Item(f"im judge {m} {arm} {tid}", v.judge_system(m), v.judge_user(m, by_id[tid], row), J_MAN,
                           parse=v.verdict)
            for tid, row in results(out, arm, qs).items() for m in v.METRICS}


def run_judges(out: Path, arm: str, qs: list[dict], slots: int) -> None:
    ledger, chat = Ledger(out / "calls-judge.jsonl"), llm(out / "calls-judge.jsonl", v.JUDGE, slots)
    require(chat, J_MAN)
    todo = judge_items(out, arm, qs)
    with ThreadPoolExecutor(slots) as pool:
        list(pool.map(lambda k: ledger.settle(todo[k], chat), todo))


def settled_verdicts(out: Path, arm: str, qs: list[dict]) -> dict:
    ledger = Ledger(out / "calls-judge.jsonl")
    got = {k: ledger.choose(it) for k, it in judge_items(out, arm, qs).items()}
    unsettled(got, "verdicts")
    return got


def ledger_tokens(path: Path) -> tuple[int, int, int]:
    """Calls, prompt and completion tokens of every ok record in a log."""
    n = pin = pout = 0
    for line in path.read_text(encoding="utf-8").splitlines() if path.exists() else []:
        r = json.loads(line)
        if r.get("event") == "ok":
            u = r.get("usage") or {}
            n, pin, pout = n + 1, pin + (u.get("prompt_tokens") or 0), pout + (u.get("completion_tokens") or 0)
    return n, pin, pout


def submission(out: Path, arm: str, qs: list[dict]) -> Path:
    """The per-task rows of evaluation/schema, checked by the repo's own validate_submission.py."""
    path = out / "submission.jsonl"
    cfg = {"arm": arm, "embedding": "Xenova/all-MiniLM-L6-v2" if arm == "hippo-emb" else "none (BM25)",
           "retrieval_top_k": TOPK, "answer_model": v.SNAPSHOT, "judge_model": v.SNAPSHOT}
    rows = [{"task_id": tid, "system": "hippo", "config": cfg, **row}
            for tid, row in results(out, arm, qs).items()]
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    cmd = [sys.executable, "-I", str(v.CLONE / "evaluation" / "scripts" / "validate_submission.py"), str(path),
           "--tasks", str(v.data_file("inmind.jsonl"))] + (["--allow-partial"] if Run.smoke else [])
    got = subprocess.run(cmd, capture_output=True, text=True)
    if got.returncode:
        sys.exit(f"validate_submission.py refused {path}: {(got.stdout + got.stderr).strip()[-400:]}")
    return path


def score(out: Path, arm: str, qs: list[dict]) -> None:
    qs = asked(qs)
    verdicts, tids = settled_verdicts(out, arm, qs), sorted({q["task_id"] for q in qs})
    units = [f"task-{t}" for t in tids]
    primary = set(units) if Run.smoke else set(units) - smoke_excluded("inmind", units)
    submission(out, arm, qs)
    if Run.smoke:
        lines = [f"SMOKE {NAME}, {arm}: integrity only, never scored or read",
                 f"{len(tids)} task(s) answered and judged; verdicts {sum(c.status == 'valid' for c in verdicts.values())}"
                 f" valid of {len(verdicts)}"]
    else:
        lines = [f"{NAME} as its evaluation package runs it, {arm}: top {TOPK}, gpt-5-mini answers and judges "
                 f"(InMind {v.COMMIT[:8]})"]
        for m in v.METRICS:
            got = {t: verdicts[(t, m)].value if verdicts[(t, m)].status == "valid" else 0 for t in tids}
            pg = sum(got[t] for t in tids if f"task-{t}" in primary)
            lines.append(f"{m:<14} {100 * sum(got.values()) / len(tids):6.2f}  {sum(got.values())}/{len(tids)} all tasks   "
                         f"{100 * pg / max(len(primary), 1):6.2f}  {pg}/{len(primary)} primary")
    for stage in ("answer", "judge"):
        n, pin, pout = ledger_tokens(out / f"calls-{stage}.jsonl")
        lines.append(f"{stage}: {n} calls, {pin} in, {pout} out, {(pin + pout) / max(len(tids), 1):.0f} tokens per task")
    lines += exhausted_lines(settled_answers(out, arm, qs), "answers") + exhausted_lines(verdicts, "verdicts")
    (out / ("smoke.txt" if Run.smoke else "score.txt")).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def setup(stage: str, out: Path, arm: str) -> list[dict]:
    qs, qfile = questions(), out / "questions.json"
    if stage == "ingest":
        if qfile.exists() and json.loads(qfile.read_text(encoding="utf-8"))["qids"] != [q["qid"] for q in qs]:
            sys.exit(f"{qfile} holds another question set; use a new folder")
        repo = HERE.parents[2]
        cfg = {"lane": "inmind, notes-2026-11-17-inmind.md", "arm": arm, "topk": TOPK, "smoke": Run.smoke,
               "inmind_commit": v.COMMIT, "blobs": v.BLOBS, "data_sha256": v.SHA256, "model": v.SNAPSHOT,
               "answer_cli": v.ANSWERER.cli, "judge_cli": v.JUDGE.cli,
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
    ap.add_argument("stage", choices=("ingest", "retrieve", "answer", "judge", "score", "estimate"))
    ap.add_argument("--arm", choices=("hippo-emb", "bm25"), default="hippo-emb")
    ap.add_argument("--smoke", action="store_true", help="5 tasks' stores and searches; the first task's calls")
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--shards", type=int, default=2)
    ap.add_argument("--port-base", type=int, default=9701)
    a = ap.parse_args()
    Run.smoke = a.smoke
    out = (OUT / "smoke" if a.smoke else OUT) / a.arm
    if a.stage == "estimate":
        from inmind import estimate
        Run.smoke = True
        return estimate.main(OUT / "smoke" / a.arm, a.arm)
    if a.stage == "score":
        return score(out, a.arm, setup(a.stage, out, a.arm))
    with one_writer(out):
        qs = setup(a.stage, out, a.arm)
        if a.stage in ("ingest", "retrieve"):
            ns = argparse.Namespace(out=out, arm=a.arm, arms={a.arm: SERVER_ARM[a.arm]}, store_from=None,
                                    shards=a.shards, port_base=a.port_base, stage=a.stage)
            harness.stage_ingest_retrieve(ns, sys.modules[__name__], qs)
        elif a.stage == "answer":
            run_answers(out, a.arm, asked(qs), a.slots)
        else:
            run_judges(out, a.arm, asked(qs), a.slots)


if __name__ == "__main__":
    main()
