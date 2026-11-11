"""Group B chat-QA harness (prereg Amendment 6): hippo@365 against BM25 on one benchmark, one loader each.

Stages, run in order, each resumable: ingest, retrieve, answer, judge, score.
  python -I harness.py <stage> --bench <loader> --out DIR [--limit N] [--slots 10] [--port-base 8921] [--bonferroni K]
Each arm gets its own hippo-mem0-server on its own data dir under DIR. Answers are Claude Sonnet 5 at medium effort
(claude_llm.Claude), verdicts gpt-5.6-sol at medium (codex_judge.CodexJudge) or a match, with the authors' prompts from
the loader. A question asked mid-history is searched in a store that holds only the turns before it, so ingestion and
retrieval for such a user run as one pass in `ingest`. Judge and score take every answer and verdict from the call logs
through ledger.py; answers.jsonl and verdicts.jsonl only record each run for people.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import random
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.parse
import http.client
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent
REPO = PUBLIC.parent.parent
sys.path[:0] = [str(HERE), str(PUBLIC), str(PUBLIC / "mem0")]
from claude_llm import Claude  # noqa: E402
from h2h import load, paired, primary_lines, read_jsonl, reading, run_all, sha, tokens_in  # noqa: E402,F401
from qa.ledger import (ANSWERER, JUDGE, Item, Ledger, exhausted_lines, require, smoke_excluded, trail,  # noqa: E402
                       unsettled)

ARMS = {"hippo365": "hippo", "bm25": "bm25"}  # arm -> the server's --arm
SERVER = PUBLIC / "hippo-mem0-server.mjs"


def sha_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def atomic(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)  # whole or absent


class Server:
    """One hippo-mem0-server on a port and data dir, stopped on exit."""

    def __init__(self, arm: str, port: int, data: Path, log: Path) -> None:
        self.arm, self.port, self.data, self.log = arm, port, data, log
        self.conn: http.client.HTTPConnection | None = None
        self.last = 0.0

    def __enter__(self) -> "Server":
        node = shutil.which("node") or sys.exit("node not found on PATH")
        with socket.socket() as probe:  # a server already on the port would answer the health check for ours
            if probe.connect_ex(("127.0.0.1", self.port)) == 0:
                sys.exit(f"port {self.port} is already in use; pick another --port-base")
        self.data.mkdir(parents=True, exist_ok=True)
        self.log_f = self.log.open("ab")
        self.proc = subprocess.Popen([node, str(SERVER), "--arm", ARMS[self.arm], "--port", str(self.port), "--host",
                                      "127.0.0.1", "--data-dir", str(self.data)], stdout=self.log_f, stderr=self.log_f)
        for _ in range(120):
            time.sleep(0.5)
            if self.proc.poll() is not None:
                sys.exit(f"server for {self.arm} exited at start (port {self.port} in use?); see {self.log}")
            try:
                self.health = self.call("GET", "/health")
                break
            except OSError:
                self.conn = None
        else:
            self.__exit__()
            sys.exit(f"server for {self.arm} did not answer on port {self.port}; see {self.log}")
        if self.health.get("arm") != ARMS[self.arm] or self.health.get("embeddings"):
            self.__exit__()
            sys.exit(f"server on port {self.port} is not the {self.arm} arm with embeddings off: {self.health}")
        return self

    def __exit__(self, *exc: object) -> None:
        if self.conn:
            self.conn.close()
        self.proc.terminate()
        try:
            self.proc.wait(30)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log_f.close()

    def call(self, method: str, path: str, body: dict | None = None) -> dict:
        """One request, never repeated: a repeated add would store a turn twice. A failed unit is run again whole."""
        if self.conn is None or time.monotonic() - self.last > 3:  # Node closes an idle connection after 5 s
            if self.conn:
                self.conn.close()
            self.conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=600)
        self.conn.request(method, path, json.dumps(body).encode() if body is not None else None,
                          {"Content-Type": "application/json"})
        r = self.conn.getresponse()
        data = r.read()
        self.last = time.monotonic()
        if r.status != 200:
            raise RuntimeError(f"{method} {path} on {self.arm}: {r.status} {data[:200]!r}")
        return json.loads(data)

    def add(self, user: str, turn: dict) -> int:
        body = {"messages": [{"role": turn["role"], "content": turn["content"]}], "user_id": user}
        if turn.get("timestamp") is not None:
            body["timestamp"] = turn["timestamp"]
        return len(self.call("POST", "/memories", body)["results"])

    def search(self, user: str, query: str, limit: int) -> list[dict]:
        res = self.call("POST", "/search", {"query": query, "user_id": user, "limit": limit})["results"]
        return [{k: r.get(k) for k in ("id", "memory", "score", "created_at")} for r in res]

    def delete(self, user: str) -> None:
        self.call("DELETE", "/memories?user_id=" + urllib.parse.quote(user, safe=""))


def pred_path(out: Path, arm: str, qid: str) -> Path:
    return out / "predicted" / arm / (re.sub(r"[^A-Za-z0-9._-]", "_", qid) + ".json")


def write_pred(out: Path, arm: str, q: dict, results: list[dict], topk: int, visible: int) -> None:
    rec = {"qid": q["qid"], "arm": arm, "user_id": q["user_id"], "question": q["question"], "topk": topk,
           "ask_after": q["ask_after"], "turns_visible": visible, "returned": len(results), "results": results}
    p = pred_path(out, arm, q["qid"])
    p.parent.mkdir(parents=True, exist_ok=True)
    atomic(p, json.dumps(rec, ensure_ascii=False).encode("utf-8"))


def search_for(srv: Server, q: dict, topk: int, stored: int) -> list[dict]:
    """A short list is a real result: hippo and BM25 return only memories that share a term with the query. More than
    top-k, or than the store holds so far, fails; a server error raises in Server.call."""
    res = srv.search(q["user_id"], q["question"], topk)
    if len(res) > min(topk, stored):
        raise RuntimeError(f"{srv.arm} returned {len(res)} memories for {q['qid']}, at most {min(topk, stored)} "
                           f"expected (top {topk}, {stored} stored)")
    return res


def add_turns(srv: Server, user: str, turns: list[dict]) -> int:
    return sum(srv.add(user, t) for t in turns)


def run_unit(srv: Server, mod, out: Path, user: str, turns: list[dict], qs: list[dict], phase: str) -> dict:
    """ingest: add every turn; a user with a mid-history question is searched as turns go in (phase "sweep").
    retrieve: search a user already ingested."""
    arm, n = srv.arm, len(turns)
    expected = sum(1 for t in turns if t["content"].strip())
    if phase == "retrieve":
        for q in qs:
            write_pred(out, arm, q, search_for(srv, q, mod.TOPK, expected), mod.TOPK, n)
        return {"user": user, "phase": "retrieve", "turns": n, "stored": expected, "questions": len(qs)}
    srv.delete(user)
    sweep = any(q["ask_after"] is not None for q in qs)
    stored = pos = 0
    order = sorted(qs, key=lambda q: n if q["ask_after"] is None else q["ask_after"]) if sweep else []
    for q in order:
        upto = n if q["ask_after"] is None else q["ask_after"]
        if upto > n:
            raise RuntimeError(f"{q['qid']} asks after turn {upto} of {n}")
        stored += add_turns(srv, user, turns[pos:upto])
        pos = upto
        write_pred(out, arm, q, search_for(srv, q, mod.TOPK, stored), mod.TOPK, upto)
    stored += add_turns(srv, user, turns[pos:])
    if stored != expected:
        raise RuntimeError(f"{arm} stored {stored} of {expected} turns for {user}")
    return {"user": user, "phase": "sweep" if sweep else "ingest", "turns": n, "stored": stored,
            "questions": len(qs) if sweep else 0}


def run_arm(a: argparse.Namespace, mod, arm: str, port: int, qs_by_user: dict, convs: dict, phase: str) -> None:
    out = a.out
    adir = out / "ingest" / arm
    done_path = adir / "done.jsonl"
    done = {r["user"]: r for r in read_jsonl(done_path)} if done_path.exists() else {}
    todo = []
    for user in qs_by_user:
        d = done.get(user)
        if phase == "retrieve" and not d:
            sys.exit(f"{arm}: {user} is not ingested; run the ingest stage first")
        # a user's last record wins: "sweep" and "retrieve" mean both phases are done, "ingest" only the first
        have = {"ingest": ("ingest", "sweep", "retrieve"), "retrieve": ("sweep", "retrieve")}[phase]
        if not (d and d["turns"] == len(convs[user]) and d["phase"] in have):
            todo.append(user)
    print(f"{arm}: {len(todo)} of {len(qs_by_user)} users to {phase}", flush=True)
    if not todo:
        return
    adir.mkdir(parents=True, exist_ok=True)
    with Server(arm, port, adir / "data", adir / "server.log") as srv:
        for i, user in enumerate(todo, 1):
            rec = run_unit(srv, mod, out, user, convs[user], qs_by_user[user], phase)
            with done_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec) + "\n")
            if i % 25 == 0 or i == len(todo):
                print(f"{arm}: {i}/{len(todo)} users", flush=True)
        if phase == "ingest":
            (adir / "health.json").write_text(json.dumps(srv.health), encoding="utf-8")


def setup(a: argparse.Namespace):
    mod = importlib.import_module(f"loaders.{a.bench}")
    a.out.mkdir(parents=True, exist_ok=True)
    qfile = a.out / "questions.json"
    if a.stage == "ingest":
        qs = mod.questions()
        if len({q["qid"] for q in qs}) != len(qs):
            sys.exit("loader gives duplicate qids")
        if a.limit:
            if "smoke" not in {p.lower() for p in a.out.parts}:
                sys.exit("--limit is for smoke runs: --out must sit under a folder named smoke")
            step = max(1, len(qs) // a.limit)
            qs = qs[::step][:a.limit]
        if qfile.exists() and load(qfile)["qids"] != [q["qid"] for q in qs]:
            sys.exit(f"{qfile} holds another question set; use a new --out")
        pkg = json.loads((REPO / "package.json").read_text(encoding="utf-8"))["version"]
        head = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        cfg = {"bench": a.bench, "name": mod.NAME, "topk": mod.TOPK, "licence": mod.LICENCE, "limit": a.limit,
               "arms": ARMS, "hippo_memory": pkg, "repo_head": head, "loader_sha256": sha_bytes(Path(mod.__file__).read_bytes()),
               "data_sha256": {p.name: sha_bytes(p.read_bytes()) for p in mod.DATA_FILES},
               "answerer": "claude-sonnet-5 medium", "judge": "gpt-5.6-sol medium (llm items), match otherwise"}
        qfile.write_text(json.dumps({"qids": [q["qid"] for q in qs]}), encoding="utf-8")
        (a.out / "config.json").write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    elif not qfile.exists():
        sys.exit(f"{qfile} is missing; run the ingest stage first")
    by_id = {q["qid"]: q for q in mod.questions()}
    return mod, [by_id[i] for i in load(qfile)["qids"]]


def by_user(qs: list[dict]) -> dict:
    out: dict = {}
    for q in qs:
        out.setdefault(q["user_id"], []).append(q)
    return out


def stage_ingest_retrieve(a: argparse.Namespace, mod, qs: list[dict]) -> None:
    qu = by_user(qs)
    convs = {u: t for u, t in mod.conversations() if u in qu}
    if set(convs) != set(qu):
        sys.exit(f"no conversation for users {sorted(set(qu) - set(convs))[:3]}")
    with ThreadPoolExecutor(len(ARMS)) as pool:
        futs = [pool.submit(run_arm, a, mod, arm, a.port_base + i, qu, convs, a.stage) for i, arm in enumerate(ARMS)]
        for f in futs:
            f.result()
    if a.stage == "retrieve":
        manifest = {arm: {q["qid"]: sha_bytes(pred_path(a.out, arm, q["qid"]).read_bytes()) for q in qs} for arm in ARMS}
        (a.out / "predicted" / "manifest.json").write_text(json.dumps(manifest, indent=0), encoding="utf-8")
        print(f"retrieved {len(qs)} questions for {len(ARMS)} arms; manifest written")


def prompts_of(a: argparse.Namespace, mod, qs: list[dict]) -> dict:
    """Each (arm, qid): memories shown, the retrieval file's SHA-256, system and user prompt. Stops on a file that is not
    the one the manifest hashed."""
    mf = a.out / "predicted" / "manifest.json"
    if not mf.exists():
        sys.exit("no predicted/manifest.json; run the retrieve stage first")
    man, out = load(mf), {}
    for arm in ARMS:
        for q in qs:
            raw = pred_path(a.out, arm, q["qid"]).read_bytes()
            if sha_bytes(raw) != man[arm][q["qid"]]:
                sys.exit(f"predicted file for {arm} {q['qid']} differs from the manifest")
            res = json.loads(raw)["results"]
            system, user = mod.answer_prompt(q, res)
            out[(arm, q["qid"])] = (len(res), man[arm][q["qid"]], system, user)
    return out


def answer_items(prompts: dict) -> dict:
    """Each answer prompt as a log item: its system text is the loader's for that question, checked per item."""
    return {(arm, qid): Item(f"answer {arm} {qid}", p[2], p[3], ANSWERER) for (arm, qid), p in prompts.items()}


def stage_answer(a: argparse.Namespace, mod, qs: list[dict]) -> None:
    """Asks each answer that has no valid reply in the log, up to its 3rd ask counted across every run."""
    prompts, ledger = prompts_of(a, mod, qs), Ledger(a.out / "calls-answer.jsonl")
    items = answer_items(prompts)
    got = {k: ledger.choose(item) for k, item in items.items()}
    jobs = [(*k, items[k]) for k, c in got.items() if c.status == "open"]
    random.Random(4).shuffle(jobs)  # arms interleaved, so a slow or limited stretch hits both alike
    print(f"{len(jobs)} answers to ask, {sum(c.status == 'valid' for c in got.values())} valid in the log", flush=True)
    print("\n".join(exhausted_lines(got, "answers")), flush=True)
    if not jobs:
        return
    claude = Claude(a.out / "claude", a.out / "calls-answer.jsonl", a.slots)
    require(claude, ANSWERER)

    def one(job: tuple) -> dict:
        arm, qid, item = job
        ch = ledger.settle(item, claude)
        n, ret, system, _ = prompts[(arm, qid)]
        return {"arm": arm, "qid": qid, "memories": n, "retrieval": ret, "prompt": sha(item.user), "system": sha(system),
                "tokens_in": tokens_in(ch.record or {}), "answer": ch.value, **trail(ch)}

    run_all(jobs, one, a.out / "answers.jsonl", a.slots)


def all_answers(a: argparse.Namespace, mod, qs: list[dict]) -> dict:
    """Every answer as its call log settles it, made from the prompt and retrieval file now on disk, or stop while one
    still has asks left. An exhausted answer holds None and scores wrong."""
    prompts, ledger, answers = prompts_of(a, mod, qs), Ledger(a.out / "calls-answer.jsonl"), {}
    for k, item in answer_items(prompts).items():
        c = ledger.choose(item)
        answers[k] = {"answer": c.value, "memories": prompts[k][0], "tokens_in": tokens_in(c.record or {}), "choice": c}
    unsettled({k: r["choice"] for k, r in answers.items()}, "answers")
    return answers


def llm_items(mod, qs: list[dict], answers: dict) -> tuple[dict, dict]:
    """(arm, qid) -> (system, prompt, parse) for the llm-judged answers, and (arm, qid) -> bool for the matched. An
    exhausted answer is in neither: it scores wrong with nothing to judge."""
    by_id, llm, matched = {q["qid"]: q for q in qs}, {}, {}
    for (arm, qid), r in answers.items():
        if r["answer"] is None:
            continue
        j = mod.judge(by_id[qid], r["answer"])
        if j[0] == "match":
            matched[(arm, qid)] = bool(j[1])
        else:
            llm[(arm, qid)] = j[1:]
    return llm, matched


def judge_key(a: argparse.Namespace, llm: dict, answers: dict) -> dict:
    """The blind key, one shuffled pass over both arms, checked to map one to one onto the llm-judged answers now."""
    path = a.out / "judge_key.json"
    if not path.exists():
        items = sorted(llm)
        random.Random(7).shuffle(items)
        key = {f"j{i:05d}": {"arm": arm, "qid": qid, "sha": sha(answers[(arm, qid)]["answer"])}
               for i, (arm, qid) in enumerate(items)}
        atomic(path, json.dumps(key, indent=0).encode("utf-8"))
    key = load(path)
    items = {(k["arm"], k["qid"]): k["sha"] for k in key.values()}
    if len(items) != len(key) or set(items) != set(llm) or any(s != sha(answers[i]["answer"]) for i, s in items.items()):
        sys.exit("judge_key.json does not map one to one onto the answers as they are now")
    return key


def judge_items(key: dict, llm: dict) -> dict:
    """Each keyed answer's judge prompt as a log item under the judge's manifest."""
    return {jid: Item(f"judge {jid}", *llm[(k["arm"], k["qid"])][:2], JUDGE, llm[(k["arm"], k["qid"])][2])
            for jid, k in key.items()}


def stage_judge(a: argparse.Namespace, mod, qs: list[dict]) -> None:
    """Asks each keyed verdict that has no valid reply in the log, up to its 3rd ask counted across every run."""
    answers = all_answers(a, mod, qs)
    llm, matched = llm_items(mod, qs, answers)
    print(f"{len(matched)} answers scored by match, {len(llm)} for the judge", flush=True)
    if not llm:
        return
    key = judge_key(a, llm, answers)
    items, ledger = judge_items(key, llm), Ledger(a.out / "calls-judge.jsonl")
    got = {jid: ledger.choose(item) for jid, item in items.items()}
    jobs = [(jid, items[jid]) for jid, c in got.items() if c.status == "open"]
    print(f"{len(jobs)} verdicts to ask, {sum(c.status == 'valid' for c in got.values())} valid in the log", flush=True)
    print("\n".join(exhausted_lines(got, "verdicts")), flush=True)
    if not jobs:
        return
    try:
        from codex_judge import CodexJudge  # noqa: E402
    except ImportError:
        sys.exit("benchmarks/public/qa/codex_judge.py is missing; it comes from the codex-judge lane")
    judge = CodexJudge(log=a.out / "calls-judge.jsonl", slots=a.slots)
    require(judge, JUDGE)

    def one(job: tuple) -> dict:
        jid, item = job
        ch = ledger.settle(item, judge)
        return {"id": jid, "prompt": sha(item.user), "correct": ch.value, **trail(ch)}

    run_all(jobs, one, a.out / "verdicts.jsonl", a.slots)


def units(qs: list[dict]) -> dict:
    """Each question's bootstrap unit: the user that owns its store (prereg Amendment 6 revision 1 item 9), or the
    question itself when one store holds every question, as HotPotQA-24's does (dated notes 1)."""
    one_store = len({q["user_id"] for q in qs}) == 1
    return {q["qid"]: q["qid"] if one_store else q["user_id"] for q in qs}


def primary_ids(a: argparse.Namespace, mod, ids: list[str]) -> tuple[list[str], str]:
    """The questions every primary reads and the line naming what it leaves out: the registered smoke items (dated
    notes 1). A smoke run is never scored, so it keeps every question under a SMOKE label."""
    if load(a.out / "config.json").get("limit"):
        return ids, "SMOKE run: never scored or reused"
    smoke = smoke_excluded(a.bench, [q["qid"] for q in mod.questions()])
    return [i for i in ids if i not in smoke], f"smoke items left out of every primary: {', '.join(sorted(smoke)) or 'none'}"


def stage_score(a: argparse.Namespace, mod, qs: list[dict]) -> None:
    """Accuracy per arm and hippo365 minus bm25 over the store-owning unit, smoke items left out, exhausted ones listed."""
    answers = all_answers(a, mod, qs)
    llm, matched = llm_items(mod, qs, answers)
    correct = {k: 0.0 for k in answers}  # an exhausted answer or verdict scores wrong
    correct.update({k: float(v) for k, v in matched.items()})
    listed = exhausted_lines({k: r["choice"] for k, r in answers.items()}, "answers")
    if llm:
        key, ledger = judge_key(a, llm, answers), Ledger(a.out / "calls-judge.jsonl")
        got = {jid: ledger.choose(item) for jid, item in judge_items(key, llm).items()}
        unsettled(got, "verdicts")
        correct.update({(key[j]["arm"], key[j]["qid"]): float(c.value) for j, c in got.items() if c.status == "valid"})
        listed += exhausted_lines(got, "verdicts")
    cats, ids, unit = {q["qid"]: q["category"] for q in qs}, [q["qid"] for q in qs], units(qs)
    primary, note = primary_ids(a, mod, ids)
    lines = [f"{mod.NAME}: {len(ids)} questions, {len(primary)} in the primary, top {mod.TOPK}, answers {len(answers)}, "
             f"{len(llm)} judged by model, {len(matched)} by match"]
    for arm in ARMS:
        rs = [answers[(arm, i)] for i in primary]
        toks = [r["tokens_in"] for r in rs if r["answer"] is not None]
        lines.append(f"{arm:>9}  accuracy {100 * sum(correct[(arm, i)] for i in primary) / len(primary):5.1f}  "
                     f"memories {sum(r['memories'] for r in rs) / len(rs):5.1f}  "
                     f"input tokens {sum(toks) / max(1, len(toks)):7.0f}")
    diff = {i: correct[("hippo365", i)] - correct[("bm25", i)] for i in ids}
    lines += primary_lines("hippo365 - bm25 all", diff, primary, ids, unit.get, a.bonferroni)
    for c in sorted(set(cats.values())) if len(set(cats.values())) > 1 else []:
        if sub := [i for i in primary if cats[i] == c]:
            lines.append(f"secondary hippo365 - bm25 {c}: {paired(diff, sub, unit.get)}")
    lines += ["", note, *listed]
    text = "\n".join(lines)
    (a.out / "score.txt").write_text(text + "\n", encoding="utf-8")
    print(text)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("ingest", "retrieve", "answer", "judge", "score"))
    ap.add_argument("--bench", required=True, help="loader module in loaders/")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--limit", type=int, default=0, help="smoke only: this many questions, spread over the set")
    ap.add_argument("--slots", type=int, default=10)
    ap.add_argument("--port-base", type=int, default=8921, help="hippo arm here, bm25 on the next port")
    ap.add_argument("--bonferroni", type=int, metavar="K", help="score: also the primary's interval at 1 - 0.05/K")
    a = ap.parse_args()
    if a.bonferroni is not None and (a.stage != "score" or a.bonferroni < 1):
        ap.error("--bonferroni K needs the score stage and K of 1 or more")
    mod, qs = setup(a)
    {"ingest": stage_ingest_retrieve, "retrieve": stage_ingest_retrieve, "answer": stage_answer, "judge": stage_judge,
     "score": stage_score}[a.stage](a, mod, qs)


if __name__ == "__main__":
    main()
