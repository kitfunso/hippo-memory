"""Terminal-Bench 2.0 with Claude Code, arms `none` and `hippo`, one harbor job per (task, arm).

  python -I run_tbench.py bundle --out DIR             # linux node + hippo dist + hook settings, once
  python -I run_tbench.py run --out RUN --bundle DIR [--limit N] [--tasks a,b] [--arms none,hippo]
  python -I run_tbench.py store --out RUN --bundle DIR # memories in the hippo arm's store, as JSON

Tasks run in one fixed order (sorted names, shuffled with seed 1); both arms of a task run at the
same time, and the next task starts when both end. The hippo arm's store is one docker volume that
every hippo task mounts, so it carries across tasks. Re-running `run` resumes: a finished
(task, arm) is skipped. A trial whose agent never started, or whose session ended on a usage
limit, is infrastructure: it is retried, the hippo store first restored to its copy from before
that task. Progress lines go to RUN/progress.jsonl, one per finished trial.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
HARBOR = os.environ.get("HARBOR_EXE", "harbor")
TASKS = Path(os.environ.get("TBENCH_TASKS", "C:/Users/skf_s/hippo-bench/tbench/data/terminal-bench"))
MODEL = "anthropic/claude-sonnet-5"
EFFORT = "medium"
CLAUDE_VERSION = "2.1.321"  # pinned so a multi-day run never changes agent build mid-way
HELPER_IMAGE = "node:22-bookworm-slim"
SETUP_SEC = 1800  # harbor's apt install of nodejs and npm took over the 360 s default in the smoke
SEED = 1
# hippo runs from a docker volume: from a Windows bind mount each call took 40 s to load, against 0.3 s.
BUNDLE_VOL = "hippo-tbench-bundle"
ARMS = ("none", "hippo")
AUTH_RE = re.compile(r"invalid api key|authentication|oauth token|not logged in|/login", re.I)
LOCK = threading.Lock()


def log(msg: str) -> None:
    with LOCK:
        print(time.strftime("%H:%M:%S"), msg, flush=True)


def sh(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)


def task_order() -> list[str]:
    names = sorted(p.parent.name for p in TASKS.glob("*/task.toml"))
    random.Random(SEED).shuffle(names)
    return names


def task_digest(name: str) -> str:
    h = hashlib.sha256()
    for p in sorted((TASKS / name).rglob("*")):
        if p.is_file():
            h.update(p.relative_to(TASKS / name).as_posix().encode() + b"\0" + p.read_bytes())
    return h.hexdigest()


# ---------- bundle: a linux hippo every task container can run, mounted read-only ----------

def bundle(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    pkg = out / "pkg"
    if pkg.exists():
        shutil.rmtree(pkg)
    for part in ("bin", "dist"):
        shutil.copytree(REPO / part, pkg / part)
    shutil.copy2(REPO / "package.json", pkg / "package.json")
    mount = ["-v", f"{out.as_posix()}:/opt/hippo"]
    r = sh(["docker", "run", "--rm", *mount, HELPER_IMAGE, "cp", "/usr/local/bin/node", "/opt/hippo/node"])
    if r.returncode:
        sys.exit(f"copying node out of {HELPER_IMAGE} failed: {r.stderr}")
    # HIPPO_HOME is fixed here so the hooks, the MCP server and every helper use the one store.
    (out / "hippo").write_bytes(
        b'#!/bin/sh\nHIPPO_HOME=/hippo-store exec /opt/hippo/node /opt/hippo/pkg/bin/hippo.js "$@"\n')
    # The arm's hooks are exactly what `hippo hook install claude-code` writes, with the binary's path.
    r = sh(["docker", "run", "--rm", *mount, "-e", "CLAUDE_CONFIG_DIR=/tmp/cfg", "-e", "HIPPO_SKIP_AUTO_INTEGRATIONS=1",
            HELPER_IMAGE, "sh", "-c", "mkdir -p /tmp/cfg && sh /opt/hippo/hippo hook install claude-code >&2"
            " && cat /tmp/cfg/settings.json"])
    if r.returncode:
        sys.exit(f"hook install failed: {r.stderr}")
    settings = json.loads(r.stdout)
    for groups in settings["hooks"].values():
        for g in groups:
            for h in g["hooks"]:
                cmd = re.sub(r"^hippo ", "/opt/hippo/hippo ", h["command"])
                h["command"] = re.sub(r'"/root/\.hippo/logs/', '"/hippo-store/logs/', cmd)
    (out / "settings-hippo.json").write_text(json.dumps(settings, indent=2), encoding="utf-8")
    ver = sh(["docker", "run", "--rm", *mount, HELPER_IMAGE, "sh", "/opt/hippo/hippo", "--version"])
    meta = {"hippo_version": json.loads((pkg / "package.json").read_text())["version"],
            "hippo_cli_version": ver.stdout.strip(), "git_head": sh(["git", "-C", str(REPO), "rev-parse", "HEAD"]).stdout.strip(),
            "node": sh(["docker", "run", "--rm", *mount, HELPER_IMAGE, "/opt/hippo/node", "--version"]).stdout.strip(),
            "hooks": {k: [h["command"] for g in v for h in g["hooks"]] for k, v in settings["hooks"].items()}}
    (out / "bundle.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    sh(["docker", "volume", "rm", BUNDLE_VOL])
    sh(["docker", "volume", "create", BUNDLE_VOL])
    r = sh(["docker", "run", "--rm", "-v", f"{out.as_posix()}:/src:ro", "-v", f"{BUNDLE_VOL}:/opt/hippo", HELPER_IMAGE,
            "sh", "-c", "cp -a /src/. /opt/hippo/ && chmod 755 /opt/hippo/hippo /opt/hippo/node"])
    if r.returncode:
        sys.exit(f"filling volume {BUNDLE_VOL} failed: {r.stderr}")
    print(json.dumps(meta, indent=2))


# ---------- the hippo store volume ----------

def volume_name(run: Path) -> str:
    return "hippo-tbench-" + hashlib.sha256(str(run.resolve()).encode()).hexdigest()[:10]


def helper(run: Path, bdir: Path, *cmd: str, extra: list[str] | None = None) -> subprocess.CompletedProcess:
    return sh(["docker", "run", "--rm", "-v", f"{volume_name(run)}:/hippo-store", "-v", f"{BUNDLE_VOL}:/opt/hippo:ro",
               *(extra or []), "-w", "/", HELPER_IMAGE, *cmd])


def init_store(run: Path, bdir: Path) -> None:
    vol = volume_name(run)
    if sh(["docker", "volume", "inspect", vol]).returncode == 0:
        return
    sh(["docker", "volume", "create", vol])
    r = helper(run, bdir, "sh", "-c", "/opt/hippo/hippo init --global --no-hooks --no-schedule --no-learn"
               " && chmod 700 /hippo-store")
    if r.returncode:
        sys.exit(f"store init failed: {r.stdout}{r.stderr}")


def store_memories(run: Path, bdir: Path) -> list[dict]:
    # `export` reads only a project store, so the global store is reached through a `.hippo` link.
    r = helper(run, bdir, "sh", "-c", "mkdir -p /w && ln -s /hippo-store /w/.hippo && cd /w && /opt/hippo/hippo export")
    if r.returncode:
        raise RuntimeError(f"hippo export failed: {r.stderr[-500:]}")
    data = json.loads(r.stdout)
    return data if isinstance(data, list) else data.get("memories", data.get("entries", []))


def snapshot(run: Path, bdir: Path, tag: str, restore: bool = False) -> None:
    snaps = run / "hippo" / "store-snapshots"
    snaps.mkdir(parents=True, exist_ok=True)
    mount = ["-v", f"{snaps.as_posix()}:/snaps"]
    cmd = (f"rm -rf /hippo-store/* /hippo-store/.[!.]* ; tar xzf /snaps/{tag}.tgz -C /hippo-store" if restore
           else f"tar czf /snaps/{tag}.tgz -C /hippo-store .")
    r = helper(run, bdir, "sh", "-c", cmd, extra=mount)
    if r.returncode:
        raise RuntimeError(f"store {'restore' if restore else 'snapshot'} {tag} failed: {r.stderr[-500:]}")


# ---------- one trial ----------

def agent_env() -> dict[str, str]:
    """Harbor's process env: the parked subscription token as CLAUDE_CODE_OAUTH_TOKEN, no API key, no session vars."""
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("CLAUDE", "ANTHROPIC")) and k != "CLAUDECODE"}
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN_DISABLED") or sh(
        ["powershell.exe", "-NoProfile", "-Command",
         "[Environment]::GetEnvironmentVariable('CLAUDE_CODE_OAUTH_TOKEN_DISABLED','User')"]).stdout.strip()
    if not token:
        sys.exit("CLAUDE_CODE_OAUTH_TOKEN_DISABLED is not set in the User environment")
    env.update(CLAUDE_CODE_OAUTH_TOKEN=token, CLAUDE_FORCE_OAUTH="1", PYTHONIOENCODING="utf-8")
    return env


def job_config(run: Path, bdir: Path, arm: str, idx: int, name: str, attempt: int) -> tuple[Path, str]:
    job = f"{idx:02d}-{name}-a{attempt}"
    agent: dict = {"name": "claude-code", "model_name": MODEL, "override_setup_timeout_sec": SETUP_SEC,
                   "kwargs": {"reasoning_effort": EFFORT, "version": CLAUDE_VERSION}}
    env: dict = {"type": "docker", "delete": True}
    if arm == "hippo":
        agent["kwargs"]["config"] = (bdir / "settings-hippo.json").as_posix()
        agent["mcp_servers"] = [{"name": "hippo", "transport": "stdio", "command": "/opt/hippo/hippo", "args": ["mcp"]}]
        overlay = run / "hippo" / "compose-hippo.json"
        overlay.write_text(json.dumps({
            "services": {"main": {"volumes": [
                {"type": "volume", "source": BUNDLE_VOL, "target": "/opt/hippo", "read_only": True},
                {"type": "volume", "source": volume_name(run), "target": "/hippo-store"}]}},
            "volumes": {volume_name(run): {"external": True}, BUNDLE_VOL: {"external": True}}}, indent=2),
            encoding="utf-8")
        env["extra_docker_compose"] = [overlay.as_posix()]
    cfg = {"job_name": job, "jobs_dir": (run / arm / "jobs").as_posix(), "n_attempts": 1,
           "n_concurrent_trials": 1, "quiet": True, "environment": env, "agents": [agent],
           "tasks": [{"path": (TASKS / name).as_posix()}]}
    path = run / arm / "configs" / f"{job}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return path, job


def trial_outcome(job_dir: Path) -> dict:
    """reward, and whether the trial is infrastructure (agent never ran, or a usage limit ended it)."""
    results = [p for p in job_dir.glob("*/result.json")]
    if not results:
        return {"infra": True, "why": "no trial result"}
    raw = results[0].read_bytes()
    try:
        res = json.loads(raw.decode("utf-8"))
    except UnicodeDecodeError:  # harbor on Windows writes result.json in the ANSI code page
        res = json.loads(raw.decode("cp1252", errors="replace"))
    trial = results[0].parent
    out_txt = trial / "agent" / "claude-code.txt"
    tail = out_txt.read_text(encoding="utf-8", errors="replace")[-20000:] if out_txt.exists() else ""
    events = [json.loads(l) for l in tail.splitlines() if l.startswith("{") and l.rstrip().endswith("}")]
    last = next((e for e in reversed(events) if e.get("type") == "result"), None)
    rejected = [e["rate_limit_info"].get("resetsAt") for e in events
                if e.get("type") == "rate_limit_event" and (e.get("rate_limit_info") or {}).get("status") == "rejected"]
    exc = (res.get("exception_info") or {})
    rewards = ((res.get("verifier_result") or {}).get("rewards") or {})
    reward = float(rewards.get("reward", 0.0) or 0.0)
    ran = bool(res.get("agent_execution")) and last is not None
    # A session that ends on an API error (usage limit, overload, outage) never got its full try: infrastructure.
    api_err = bool(last and last.get("is_error") and (last.get("terminal_reason") == "api_error" or last.get("api_error_status")))
    limit = bool(rejected) or bool(last and last.get("api_error_status") == 429)
    auth = bool(AUTH_RE.search(tail[-3000:])) and not (last and last.get("num_turns", 0) > 1)
    return {"reward": reward, "infra": (not ran) or api_err or limit, "limit": limit, "auth": auth,
            "resets_at": max((r for r in rejected if r), default=None), "api_error": (last or {}).get("api_error"),
            "exception": exc.get("exception_type"), "trial": trial.as_posix(),
            "agent_sec": _secs(res.get("agent_execution")), "cost_usd": (last or {}).get("total_cost_usd"),
            "turns": (last or {}).get("num_turns"),
            "why": (exc.get("exception_message") or "")[:300] if not ran else str((last or {}).get("result", ""))[:200] if api_err else ""}


def _secs(t: dict | None) -> float | None:
    if not t or not t.get("started_at") or not t.get("finished_at"):
        return None
    from datetime import datetime
    return (datetime.fromisoformat(t["finished_at"]) - datetime.fromisoformat(t["started_at"])).total_seconds()


def done(run: Path) -> dict[tuple[str, str], dict]:
    p = run / "progress.jsonl"
    if not p.exists():
        return {}
    recs = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
    return {(r["task"], r["arm"]): r for r in recs if not r.get("infra")}


def run_one(run: Path, bdir: Path, arm: str, idx: int, name: str, env: dict) -> dict:
    # Attempts count across resumes, so a job name is never reused and harbor never resumes an old job.
    first = 1 + len(list((run / arm / "configs").glob(f"{idx:02d}-{name}-a*.json")))
    for attempt in range(first, first + 100):
        if arm == "hippo":
            tag = f"before-{idx:02d}"
            # The first try of a task saves the store; any later try, or a resume after a kill, starts from that copy.
            restore = (run / "hippo" / "store-snapshots" / f"{tag}.tgz").exists()
            snapshot(run, bdir, tag, restore=restore)
        cfg, job = job_config(run, bdir, arm, idx, name, attempt)
        t0 = time.time()
        r = sh([HARBOR, "run", "-c", str(cfg)], env=env, timeout=6 * 3600)
        (run / arm / "configs" / f"{job}.log").write_text(r.stdout[-20000:] + "\n--stderr--\n" + r.stderr[-20000:], encoding="utf-8")
        out = trial_outcome(run / arm / "jobs" / job)
        rec = {"idx": idx, "task": name, "arm": arm, "attempt": attempt, "wall_sec": round(time.time() - t0), **out}
        if arm == "hippo" and not out.get("infra"):
            rec["store_after"] = len(store_memories(run, bdir))
        with LOCK, (run / "progress.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
        log(f"{idx:02d} {name} {arm} a{attempt}: reward={out.get('reward')} infra={out.get('infra')} "
            f"{out.get('why') or ''}")
        if out.get("auth"):
            raise SystemExit(f"{arm} {name}: authentication failed; fix the token and re-run (resumes)")
        if not out.get("infra"):
            return rec
        if attempt - first >= 2 and not out.get("limit"):
            raise SystemExit(f"{arm} {name}: 3 infrastructure failures, see {cfg}.log; re-run resumes here")
        wait = max(60, (out.get("resets_at") or 0) + 120 - time.time()) if out.get("limit") else 60
        log(f"{arm} {name}: infrastructure ({out.get('api_error') or out.get('why')}), retry in {wait / 60:.0f} min")
        time.sleep(wait)
    raise SystemExit("unreachable")


def run_all(run: Path, bdir: Path, arms: list[str], limit: int | None, only: list[str], seed: str) -> None:
    run.mkdir(parents=True, exist_ok=True)
    order = list(enumerate(task_order()))
    if only:
        order = [(i, n) for i, n in order if n in only]
    order = order[:limit] if limit else order
    manifest = run / "order.json"
    if not manifest.exists():
        manifest.write_text(json.dumps({
            "seed": SEED, "model": MODEL, "effort": EFFORT, "claude_code": CLAUDE_VERSION, "arms": arms,
            "bundle": json.loads((bdir / "bundle.json").read_text()) if "hippo" in arms else None,
            "tasks": [{"idx": i, "task": n, "sha256": task_digest(n)} for i, n in order]}, indent=2),
            encoding="utf-8")
    if "hippo" in arms:
        fresh = sh(["docker", "volume", "inspect", volume_name(run)]).returncode != 0
        init_store(run, bdir)
        if seed and fresh:
            # Smoke only: one memory so the recall hook has something to show in the transcript.
            if "smoke" not in run.as_posix():
                sys.exit("--seed-memory is for smoke runs only")
            r = helper(run, bdir, "/opt/hippo/hippo", "remember", "--global", seed)
            if r.returncode:
                sys.exit(f"seeding failed: {r.stderr[-300:]}")
    env = agent_env()
    finished = done(run)
    with ThreadPoolExecutor(len(arms)) as pool:
        for idx, name in order:
            todo = [a for a in arms if (name, a) not in finished]
            if todo:
                list(pool.map(lambda a: run_one(run, bdir, a, idx, name, env), todo))
    log("all tasks done")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["bundle", "run", "store"])
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--bundle", type=Path)
    ap.add_argument("--arms", default="none,hippo")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--seed-memory", default="", help="smoke only: one memory stored before the first task")
    ap.add_argument("--tasks", default="", help="comma-separated task names (smoke); idx stays the full order's")
    a = ap.parse_args()
    if a.cmd == "bundle":
        bundle(a.out.resolve())
    elif a.cmd == "run":
        arms = [x for x in a.arms.split(",") if x]
        if not set(arms) <= set(ARMS):
            sys.exit(f"arms must be among {ARMS}")
        run_all(a.out.resolve(), a.bundle.resolve(), arms, a.limit, [x for x in a.tasks.split(",") if x],
                a.seed_memory)
    else:
        print(json.dumps(store_memories(a.out.resolve(), a.bundle.resolve()), indent=1))


if __name__ == "__main__":
    main()
