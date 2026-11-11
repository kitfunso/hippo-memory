"""Group B chat-QA harness (prereg Amendment 6): hippo@365 against BM25 on one benchmark, one loader each.

Stages, run in order, each resumable: ingest, retrieve, answer, judge, score.
  python -I harness.py <stage> --bench <loader> --out DIR [--limit N] [--slots 10] [--port-base 8921]
Each arm gets its own hippo-mem0-server on its own data dir under DIR. Answers are Claude Sonnet 5 at medium effort
(claude_llm.Claude), verdicts gpt-5.6-sol at medium (codex_judge.CodexJudge) or a match, with the authors' prompts from
the loader. A question asked mid-history is searched in a store that holds only the turns before it, so ingestion and
retrieval for such a user run as one pass in `ingest`.
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
from evidence_recall import boot  # noqa: E402
from h2h import load, read_jsonl, reading, records, replies, run_all, sha, tokens_in  # noqa: E402

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
           "ask_after": q["ask_after"], "turns_visible": visible, "results": results}
    p = pred_path(out, arm, q["qid"])
    p.parent.mkdir(parents=True, exist_ok=True)
    atomic(p, json.dumps(rec, ensure_ascii=False).encode("utf-8"))


def search_for(srv: Server, q: dict, topk: int, stored: int) -> list[dict]:
    res = srv.search(q["user_id"], q["question"], topk)
    if len(res) != min(topk, stored):
        raise RuntimeError(f"{srv.arm} returned {len(res)} memories for {q['qid']}, expected {min(topk, stored)}")
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


def answers_on_file(a: argparse.Namespace, prompts: dict) -> dict:
    """The answers so far, each made from the prompt and retrieval file now on disk and equal to a logged reply to it."""
    answers = records(a.out / "answers.jsonl", lambda r: (r["arm"], r["qid"]))
    said = replies(a.out / "calls-answer.jsonl")
    stale = [k for k, r in answers.items() if k not in prompts or r["prompt"] != sha(prompts[k][3])
             or r["system"] != sha(prompts[k][2]) or r["retrieval"] != prompts[k][1]
             or r["answer"] not in said.get((f"answer {k[0]} {k[1]}", r["prompt"][:16]), [])]
    if stale:
        sys.exit(f"answers.jsonl holds {len(stale)} answers made from other inputs or not in the call log, e.g. "
                 f"{stale[0]}; move it aside and answer again")
    return answers


def stage_answer(a: argparse.Namespace, mod, qs: list[dict]) -> None:
    prompts = prompts_of(a, mod, qs)
    done = answers_on_file(a, prompts)
    jobs = [(arm, qid, p[3]) for (arm, qid), p in prompts.items() if (arm, qid) not in done]
    random.Random(4).shuffle(jobs)  # arms interleaved, so a slow or limited stretch hits both alike
    claude = Claude(a.out / "claude", a.out / "calls-answer.jsonl", a.slots)

    def one(job: tuple) -> dict:
        arm, qid, user = job
        n, ret, system, _ = prompts[(arm, qid)]
        r = claude.ask(system, user, effort="medium", tag=f"answer {arm} {qid}")
        return {"arm": arm, "qid": qid, "memories": n, "retrieval": ret, "prompt": sha(user), "system": sha(system),
                "tokens_in": tokens_in(r), "answer": r["text"]}

    print(f"{len(jobs)} answers to make, {len(done)} already made", flush=True)
    run_all(jobs, one, a.out / "answers.jsonl", a.slots)


def all_answers(a: argparse.Namespace, mod, qs: list[dict]) -> dict:
    answers = answers_on_file(a, prompts_of(a, mod, qs))
    missing = len(qs) * len(ARMS) - len(answers)
    if missing:
        sys.exit(f"answers: {missing} of {len(qs) * len(ARMS)} missing")
    return answers


def llm_items(mod, qs: list[dict], answers: dict) -> tuple[dict, dict]:
    """(arm, qid) -> (system, prompt, parse) for the llm-judged answers, and (arm, qid) -> bool for the matched."""
    by_id, llm, matched = {q["qid"]: q for q in qs}, {}, {}
    for (arm, qid), r in answers.items():
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


def verdicts_on_file(a: argparse.Namespace, key: dict, llm: dict) -> dict:
    """The verdicts so far, each on the judge prompt as it is now and equal to the parse of a logged reply to it."""
    verdicts = records(a.out / "verdicts.jsonl", lambda r: r["id"])
    said = replies(a.out / "calls-judge.jsonl")
    bad = []
    for jid, v in verdicts.items():
        if jid not in key:
            bad.append(jid)
            continue
        _, prompt, parse = llm[(key[jid]["arm"], key[jid]["qid"])]
        if v["prompt"] != sha(prompt) or v["correct"] not in map(parse, said.get((f"judge {jid}", v["prompt"][:16]), [])):
            bad.append(jid)
    if bad:
        sys.exit(f"verdicts.jsonl holds {len(bad)} verdicts on other prompts or not read from the call log, e.g. "
                 f"{bad[0]}; judge again from an empty file")
    return verdicts


def stage_judge(a: argparse.Namespace, mod, qs: list[dict]) -> None:
    answers = all_answers(a, mod, qs)
    llm, matched = llm_items(mod, qs, answers)
    print(f"{len(matched)} answers scored by match, {len(llm)} for the judge", flush=True)
    if not llm:
        return
    key = judge_key(a, llm, answers)
    done = verdicts_on_file(a, key, llm)
    jobs = [(jid, llm[(k["arm"], k["qid"])][1]) for jid, k in key.items() if jid not in done]
    if not jobs:
        return
    try:
        from codex_judge import CodexJudge  # noqa: E402
    except ImportError:
        sys.exit("benchmarks/public/qa/codex_judge.py is missing; it comes from the codex-judge lane")
    judge = CodexJudge(log=a.out / "calls-judge.jsonl", slots=a.slots)

    def one(job: tuple) -> dict:
        jid, prompt = job
        system, _, parse = llm[(key[jid]["arm"], key[jid]["qid"])]
        for _ in range(3):  # a reply with no verdict is asked again, as the runner does
            c = parse(judge.ask(system, prompt, tag=f"judge {jid}")["text"])
            if c is not None:
                return {"id": jid, "prompt": sha(prompt), "correct": c}
        raise RuntimeError("no verdict in 3 replies")

    print(f"{len(jobs)} verdicts to get, {len(done)} already in", flush=True)
    run_all(jobs, one, a.out / "verdicts.jsonl", a.slots)


def stage_score(a: argparse.Namespace, mod, qs: list[dict]) -> None:
    answers = all_answers(a, mod, qs)
    llm, matched = llm_items(mod, qs, answers)
    correct = {k: float(v) for k, v in matched.items()}
    if llm:
        key = judge_key(a, llm, answers)
        verdicts = verdicts_on_file(a, key, llm)
        if set(verdicts) != set(key):
            sys.exit(f"{len(verdicts)} verdicts for {len(key)} keyed answers; never scored partial")
        correct.update({(k["arm"], k["qid"]): float(verdicts[j]["correct"]) for j, k in key.items()})
    cats = {q["qid"]: q["category"] for q in qs}
    ids = [q["qid"] for q in qs]
    lines = [f"{mod.NAME}: {len(ids)} questions, top {mod.TOPK}, answers {len(answers)}, "
             f"{len(llm)} judged by model, {len(matched)} by match"]
    for arm in ARMS:
        rs = [answers[(arm, i)] for i in ids]
        lines.append(f"{arm:>9}  accuracy {100 * sum(correct[(arm, i)] for i in ids) / len(ids):5.1f}  "
                     f"memories {sum(r['memories'] for r in rs) / len(rs):5.1f}  "
                     f"input tokens {sum(r['tokens_in'] for r in rs) / len(rs):7.0f}")
    for name, sub in [("all", ids)] + [(c, [i for i in ids if cats[i] == c]) for c in sorted(set(cats.values()))]:
        if name != "all" and len(set(cats.values())) == 1:
            continue
        d, lo, hi = boot([correct[("hippo365", i)] - correct[("bm25", i)] for i in sub])
        tag = "PRIMARY " if name == "all" else "secondary "
        lines.append(f"{tag}hippo365 - bm25 {name}: {100 * d:+5.1f} pp [{100 * lo:+5.1f}, {100 * hi:+5.1f}] n={len(sub)}"
                     f"  {reading(d, lo, hi)}")
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
    a = ap.parse_args()
    mod, qs = setup(a)
    {"ingest": stage_ingest_retrieve, "retrieve": stage_ingest_retrieve, "answer": stage_answer, "judge": stage_judge,
     "score": stage_score}[a.stage](a, mod, qs)


if __name__ == "__main__":
    main()
