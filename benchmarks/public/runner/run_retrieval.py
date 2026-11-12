"""Retrieval for Mem0's runner benchmarks (prereg Amendment 6, group A), no model calls.

One fresh hippo-mem0-server per arm and shard with its own data dir, then the runner's own `--predict-only` at top 200.
The runner builds an LLM client anyway, so it gets a placeholder key and a dead base URL: no model call can succeed.
A shard is a slice of the benchmark's conversations (BEAM) or questions (LongMemEval) with its own server and runner, so
the add rate (about 14 per second per server, bound by file writes) scales with the ports given. Shards share nothing:
every question has its own user, so a sharded run stores and retrieves exactly what a single run would.
Usage (runner venv): python -I run_retrieval.py --bench beam-100k --arms hippo365,bm25 --ports 8911,8912 --out DIR
  --ports lists the ports arm by arm, SHARDS per arm. [--limit-convs N | --limit-questions N] for smoke runs only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
HIPPO = HERE.parents[2]
RUNNER = Path.home() / "hippo-bench" / "memory-benchmarks"
SERVER = HIPPO / "benchmarks" / "public" / "hippo-mem0-server.mjs"
SERVER_ARM = {"hippo365": "hippo", "bm25": "bm25", "hippo-emb": "hippo"}  # only hippo-emb has embeddings on (notes 5)
BENCH = {
    "beam-100k": ("beam", "100K"), "beam-500k": ("beam", "500K"), "beam-1m": ("beam", "1M"), "beam-10m": ("beam", "10M"),
    "longmemeval-s": ("lme", "longmemeval_s_cleaned.json"), "longmemeval-m": ("lme", "longmemeval_m_cleaned.json"),
}
LME_SMOKE_TYPES = "single-session-user,single-session-assistant,multi-session,knowledge-update,temporal-reasoning"
BAD_LOG = re.compile(r"failed|error|traceback|exception", re.I)
SEARCH_RETRY = re.compile(r"SEARCH attempt \d+/\d+ failed")  # a search never changes a store: the retry's result stands
ADD_RETRY = re.compile(r"ADD attempt \d+/\d+ failed \(user=([^)]+)\)")  # a retried add may be stored twice
DEAD_URL = "http://127.0.0.1:9/v1"  # port 9 (discard) refuses connections: no model call can leave this machine
MAX_RESTARTS = 20


def sha_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def plan(bench: str, a: argparse.Namespace, shards: int, out: Path) -> tuple[list[str], list[list[str]], list[set[str]]]:
    """(every question id, one runner flag list per shard, each shard's units for unit_of), read from the dataset the
    way the runner reads it."""
    sys.path.insert(0, str(RUNNER))
    kind, what = BENCH[bench]
    if kind == "beam":
        from benchmarks.beam.run import extract_probing_questions
        convs = json.loads((RUNNER / "datasets" / "beam" / f"beam_{what}.json").read_text(encoding="utf-8"))
        n = min(a.limit_convs or len(convs), len(convs))
        ids = [f"{what}_{ci}_q{qi}_{q['question_type']}" for ci in range(n)
               for qi, q in enumerate(extract_probing_questions(convs[ci]))]
        picks = [list(range(s, n, shards)) for s in range(shards)]  # round robin: sizes differ a little between convs
        return (ids, [["--chat-sizes", what, "--conversations", ",".join(map(str, p))] for p in picks if p],
                [{f"{what}_{ci}" for ci in p} for p in picks if p])
    from benchmarks.longmemeval.run import load_dataset, sample_questions_stratified
    path = RUNNER / "datasets" / "longmemeval" / what
    if shards == 1 and not a.limit_questions:
        ids = [q["question_id"] for q in load_dataset(str(path))]
        return ids, [["--all-questions"]], [set(ids)]
    qs = load_dataset(str(path))
    if a.limit_questions:
        qs = sample_questions_stratified(qs, per_type=1, seed=42, selected_types=LME_SMOKE_TYPES.split(","))[:a.limit_questions]
    flags, units = [], []
    (out / "slices").mkdir(parents=True, exist_ok=True)
    for s in range(shards):
        part = qs[s::shards]
        if part:
            sp = out / "slices" / f"{bench}-slice{s}.json"
            sp.write_text(json.dumps(part, ensure_ascii=False), encoding="utf-8")
            flags.append(["--all-questions", "--dataset-path", str(sp)])
            units.append({q["question_id"] for q in part})
    return [q["question_id"] for q in qs], flags, units


def wait_health(port: int, proc: subprocess.Popen, arm: str) -> None:
    """Waits for /health, then stops unless the server runs the arm's backend with embeddings on exactly for hippo-emb."""
    for _ in range(120):
        if proc.poll() is not None:
            sys.exit(f"hippo-mem0-server on {port} exited with {proc.returncode}")
        try:
            health = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2).read())
        except OSError:
            time.sleep(0.5)
            continue
        if health.get("arm") != SERVER_ARM[arm] or bool(health.get("embeddings")) != (arm == "hippo-emb"):
            proc.terminate()
            sys.exit(f"server on {port} is not the {arm} arm (hippo-emb needs @huggingface/transformers): {health}")
        return
    sys.exit(f"hippo-mem0-server on {port} did not answer /health in 60 s")


def last_launch(log: Path) -> str:
    """What the runner's last launch logged: an earlier, killed launch's users were redone from scratch."""
    return log.read_bytes().decode("utf-8", "replace").split("\n=== ")[-1] if log.exists() else ""


def drop_retried_users(pred: Path, log: Path, port: int) -> int:
    """On --resume: every user with a retried add in the last launch is deleted with its question and ingestion files,
    so the runner ingests and searches it again whole."""
    users = set(ADD_RETRY.findall(last_launch(log)))
    if not users:
        return 0
    for p in pred.glob("*.json"):
        try:
            uid = json.loads(p.read_text(encoding="utf-8")).get("user_id")
        except ValueError:
            continue
        if uid in users:
            p.unlink()
    for uid in users:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/memories?user_id={uid}", method="DELETE")
        urllib.request.urlopen(req, timeout=600).read()
    return len(users)


def drop_partial_users(pred: Path, port: int) -> int:
    """On --resume: a user whose ingestion stopped part way is deleted and ingested again whole, so no chunk is stored twice."""
    n = 0
    for prog in sorted(pred.glob("_progress_*.json")):
        uid = json.loads(prog.read_text(encoding="utf-8")).get("user_id")
        if uid:
            req = urllib.request.Request(f"http://127.0.0.1:{port}/memories?user_id={uid}", method="DELETE")
            urllib.request.urlopen(req, timeout=60).read()
        prog.unlink()
        n += 1
    return n


class Shard:
    """One server and one runner process, supervised: a killed server or runner is started again and the run resumes.

    The users whose ingestion was cut off are deleted and ingested again whole, so no chunk is stored twice."""

    def __init__(self, bench: str, arm: str, idx: int, port: int, dirp: Path, flags: list[str], resume: bool) -> None:
        self.arm, self.idx, self.port, self.dir = arm, idx, port, dirp
        self.server_restarts = self.runner_restarts = 0
        self.rc: int | None = None
        self.sweep_users: set[str] = set()
        self.sweeps = BENCH[bench][0] == "lme"  # each LongMemEval question searches right after its own ingest
        self.pred = dirp / f"predicted_{bench}"
        dirp.mkdir(parents=True, exist_ok=True)
        self.store = dirp / "store"
        if self.store.exists() and not resume:
            sys.exit(f"{self.store} exists: a rerun needs --resume (partial users are deleted and redone) or a new --out")
        kind = BENCH[bench][0]
        self.cmd = [sys.executable, "-m", "benchmarks.beam.run" if kind == "beam" else "benchmarks.longmemeval.run",
                    "--project-name", bench, "--backend", "oss", "--mem0-host", f"http://127.0.0.1:{port}", "--predict-only",
                    "--top-k", "200", "--output-dir", str(dirp), "--max-workers", "8", "--resume", *flags]
        if kind == "lme":
            self.cmd += ["--mode", "answerer", "--top-k-cutoffs", "10,200"]
            if "--dataset-path" not in flags:
                self.cmd += ["--dataset-path", str(RUNNER / "datasets" / "longmemeval" / BENCH[bench][1])]
        else:
            self.cmd += ["--dataset-cache-dir", str(RUNNER / "datasets" / "beam")]
        self.env = {**os.environ, "OPENAI_API_KEY": "placeholder-no-model-call", "OPENAI_BASE_URL": DEAD_URL,
                    "TQDM_MININTERVAL": "60", "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8",
                    "PYTHONUTF8": "1"}  # the runner reads its own files with open()'s default, which is cp1252 here
        self.rlog_path = dirp / "runner.log"
        self.srv = self._start_server()
        wait_health(port, self.srv, arm)
        self._launch()
        self.thread = threading.Thread(target=self._supervise, daemon=True)
        self.thread.start()

    def _start_server(self) -> subprocess.Popen:
        slog = (self.dir / "server.log").open("ab")
        return subprocess.Popen(["node", str(SERVER), "--arm", SERVER_ARM[self.arm], "--port", str(self.port),
                                 "--data-dir", str(self.store), "--embeddings", "1" if self.arm == "hippo-emb" else "0"],
                                stdout=slog, stderr=slog)

    def _launch(self) -> None:
        if self.pred.exists():
            dropped = drop_partial_users(self.pred, self.port)
            if dropped:
                print(f"{self.arm}/{self.idx}: {dropped} partial users dropped", flush=True)
            redone = drop_retried_users(self.pred, self.rlog_path, self.port)
            if redone:
                self._note(f"{redone} users with a retried add dropped, to be redone whole")
        rlog = self.rlog_path.open("ab")
        rlog.write(f"\n=== {time.ctime()} {' '.join(self.cmd)}\n".encode())
        rlog.flush()
        self.runner = subprocess.Popen(self.cmd, cwd=RUNNER, env=self.env, stdout=rlog, stderr=subprocess.STDOUT)

    def _supervise(self) -> None:
        ticks = 0
        while True:
            rc = None
            while rc is None:
                time.sleep(1)
                ticks += 1
                if self.sweeps and ticks % 20 == 0:
                    self._sweep()
                rc = self.runner.poll()
                if rc is None and self.srv.poll() is not None:  # the runner's own retries would outlast a restart, but a
                    self.runner.kill()                          # cut-off add may be stored: redo the user whole
                    self.runner.wait()
                    rc = -1
                if self.srv.poll() is not None and self.server_restarts < MAX_RESTARTS:
                    self.server_restarts += 1
                    self._note(f"server exited {self.srv.returncode}, restart {self.server_restarts}")
                    self.srv = self._start_server()
                    wait_health(self.port, self.srv, self.arm)
            if rc == 0 or self.runner_restarts >= MAX_RESTARTS:
                self.rc = rc
                if self.sweeps:
                    self._sweep()
                return
            self.runner_restarts += 1
            self._note(f"runner exited {rc}, restart {self.runner_restarts}")
            self._launch()

    def _sweep(self) -> None:
        """Deletes the store of every user whose question file is written: the search is done and the store is only disk
        (LongMemEval-M stores run to tens of GB per arm)."""
        for p in self.pred.glob("*.json"):
            if p.name.startswith("_"):
                continue
            try:
                uid = json.loads(p.read_text(encoding="utf-8")).get("user_id")
            except ValueError:  # still being written; the next sweep gets it
                continue
            if uid and uid not in self.sweep_users:
                try:
                    urllib.request.urlopen(urllib.request.Request(
                        f"http://127.0.0.1:{self.port}/memories?user_id={uid}", method="DELETE"), timeout=600).read()
                    self.sweep_users.add(uid)
                except OSError:
                    pass  # server busy or restarting; the next sweep tries again

    def _note(self, msg: str) -> None:
        with (self.dir / "supervisor.log").open("a", encoding="utf-8") as f:
            f.write(f"{time.ctime()} {msg}\n")
        print(f"{self.arm}/{self.idx}: {msg}", flush=True)

    def wait(self) -> int:
        self.thread.join()
        return self.rc if self.rc is not None else -1

    def stop(self) -> None:
        self.srv.terminate()


def unit_of(bench: str, name: str) -> str:
    """The shard unit a predicted file belongs to: its LongMemEval question, or its BEAM conversation."""
    stem = re.sub(r"^_(ingestion|progress)_", "", name.removesuffix(".json"))
    return stem if BENCH[bench][0] == "lme" else "_".join(stem.split("_")[:2])


def unmerge(bench: str, arm_dir: Path, units: list[set[str]]) -> int:
    """On --resume after a merge: every merged file goes back to its shard, so each runner skips what it already did
    and drop_retried_users can find its users. Without it a resumed sharded run would redo every question."""
    src = arm_dir / f"predicted_{bench}"
    owner = {u: k for k, us in enumerate(units) for u in us}
    moved = 0
    for p in sorted(src.glob("*.json")) if src.is_dir() else []:
        k = owner.get(unit_of(bench, p.name))
        if k is None:
            sys.exit(f"{p} belongs to no shard of this plan: resume with the shard count of the first run")
        dest = arm_dir / f"shard{k}" / f"predicted_{bench}" / p.name
        if dest.exists():
            sys.exit(f"{p.name} is in the merged folder and in shard{k}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(p), dest)
        moved += 1
    return moved


def merge(bench: str, shards: list[Shard], arm_dir: Path) -> Path:
    """The arm's predicted dir: every shard's files moved into one."""
    dest = arm_dir / f"predicted_{bench}"
    if len(shards) == 1 and shards[0].dir == arm_dir:
        return shards[0].pred
    dest.mkdir(parents=True, exist_ok=True)
    for sh in shards:
        for p in sh.pred.glob("*.json"):
            if (dest / p.name).exists():
                sys.exit(f"{p.name} is in two shards")
            shutil.move(str(p), dest / p.name)
    return dest


def check(pred: Path, ids: list[str], runner_logs: list[Path], server_logs: list[Path], started: float) -> dict:
    """The retrieval check: every question file, no failed add or search, no failed ingestion. Written, never overridden."""
    problems = []
    files = {p.stem: p for p in pred.glob("*.json") if not p.name.startswith("_")}
    missing = [i for i in ids if i not in files]
    extra = sorted(set(files) - set(ids))
    if missing:
        problems.append(f"{len(missing)} question files missing, e.g. {missing[0]}")
    if extra:
        problems.append(f"{len(extra)} question files outside the design, e.g. {extra[0]}")
    empty, short = [], 0
    for i in ids:
        if i in files:
            r = json.loads(files[i].read_text(encoding="utf-8"))["retrieval"]
            if not r["search_results"] or r["total_results"] != len(r["search_results"]):
                empty.append(i)
            short += len(r["search_results"]) < 200
    if empty:
        problems.append(f"{len(empty)} questions retrieved nothing, e.g. {empty[0]} (a failed search returns none)")
    failed_ingest = []
    for cp in sorted(pred.glob("_ingestion_*.json")):
        d = json.loads(cp.read_text(encoding="utf-8"))
        if d.get("total_chunks_failed") or d.get("total_pairs_failed"):
            failed_ingest.append(cp.name)
    if failed_ingest:
        problems.append(f"{len(failed_ingest)} ingestions had failed adds, e.g. {failed_ingest[0]}")
    # only each runner's last launch: what an earlier, killed launch logged was redone from scratch for its users
    bad = [ln for lp in runner_logs for ln in re.split(r"[\r\n]+", last_launch(lp))
           if BAD_LOG.search(ln) and not SEARCH_RETRY.search(ln)]
    if bad:
        problems.append(f"{len(bad)} runner log lines name a failure, e.g. {bad[0][:200]}")
    slog = [ln for sp in server_logs for ln in sp.read_text(encoding="utf-8", errors="replace").splitlines()
            if BAD_LOG.search(ln) and "ExperimentalWarning" not in ln]
    if slog:
        problems.append(f"{len(slog)} server log lines name a failure, e.g. {slog[0][:200]}")
    manifest = hashlib.sha256("\n".join(f"{i}:{sha_file(files[i])}" for i in sorted(ids) if i in files).encode()).hexdigest()
    return {"pass": not problems, "problems": problems, "questions": len(ids), "files": len(files),
            "questions_with_fewer_than_200_memories": short, "manifest_sha256": manifest,
            "seconds": round(time.time() - started, 1)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bench", required=True, choices=sorted(BENCH))
    ap.add_argument("--arms", default="hippo365,bm25")
    ap.add_argument("--ports", required=True, help="ports arm by arm, SHARDS per arm; 8911-8949 are ours")
    ap.add_argument("--out", type=Path, required=True, help="results-r2/<benchmark>")
    ap.add_argument("--limit-convs", type=int, default=0, help="smoke: BEAM conversations 0..N-1")
    ap.add_argument("--limit-questions", type=int, default=0, help="smoke: LongMemEval questions, one per type")
    ap.add_argument("--resume", action="store_true")
    a = ap.parse_args()
    arms, ports = a.arms.split(","), [int(p) for p in a.ports.split(",")]
    if set(arms) - set(SERVER_ARM):
        sys.exit(f"--arms takes {', '.join(SERVER_ARM)}")
    if len(ports) % len(arms) or any(not 8911 <= p <= 8949 for p in ports) or len(set(ports)) != len(ports):
        sys.exit("--ports needs the same count of distinct ports in 8911-8949 for every arm")
    n_shards = len(ports) // len(arms)
    ids, flag_sets, units = plan(a.bench, a, n_shards, a.out)
    started = time.time()
    by_arm: dict[str, list[Shard]] = {arm: [] for arm in arms}
    verdict: dict = {}
    try:
        for ai, arm in enumerate(arms):
            if a.resume and n_shards > 1:
                moved = unmerge(a.bench, a.out / "retrieval" / arm, units)
                if moved:
                    print(f"{arm}: {moved} merged files moved back to their shards", flush=True)
            for si, flags in enumerate(flag_sets):
                dirp = a.out / "retrieval" / arm / (f"shard{si}" if n_shards > 1 else "")
                by_arm[arm].append(Shard(a.bench, arm, si, ports[ai * n_shards + si], dirp, flags, a.resume))
        for arm, shards in by_arm.items():
            rcs = [sh.wait() for sh in shards]
            arm_dir = a.out / "retrieval" / arm
            pred = merge(a.bench, shards, arm_dir)
            res = check(pred, ids, [sh.rlog_path for sh in shards], [sh.dir / "server.log" for sh in shards], started)
            res["server_restarts"] = sum(sh.server_restarts for sh in shards)
            res["runner_restarts"] = sum(sh.runner_restarts for sh in shards)
            if any(rcs):
                res["pass"], res["problems"] = False, [f"runner exit codes {rcs}", *res["problems"]]
            (arm_dir / "retrieval-check.json").write_text(json.dumps(res, indent=1), encoding="utf-8")
            verdict[arm] = res
    finally:
        for shards in by_arm.values():
            for sh in shards:
                sh.stop()
    print(json.dumps({"bench": a.bench, "arms": {k: {"pass": v["pass"], "problems": v["problems"], "seconds": v["seconds"],
                                                       "files": v["files"]} for k, v in verdict.items()}}))
    sys.exit(0 if all(v["pass"] for v in verdict.values()) else 1)


if __name__ == "__main__":
    main()
