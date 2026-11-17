"""DolphinBench in the official Claude Code + Sonnet 5 setup, with hippo-memory as the memory plugin.

The official modules do the work: claude_code.ingest() gives the history one Claude Code turn per message, and
run_simulation's external runtime asks the tests through claude_agent.run_plugin(). Each Claude Code process runs in
a bubblewrap sandbox (dolphin_sandbox.py) under its own uid. Every stage but judge runs as root in WSL; the launcher
is run-dolphin-official.sh and the prereg is docs/evals/2026-11-17-dolphinbench-official-prereg.md.
"""
from __future__ import annotations

import argparse
import contextlib
import dataclasses
import fcntl
import hashlib
import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import tarfile
import threading
import time
from argparse import Namespace
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from dolphin_home import BENCH
from dolphin_sandbox import BASE, HOMES, drain_report

log = logging.getLogger("dolphin_official")
HERE = Path(__file__).resolve().parent
SETUP = BASE / "setup.json"
SANDBOX = BASE / "bin" / "dolphin_sandbox.py"
PROVIDER, MODEL, CLAUDE_VERSION = "hippo-memory", "claude-sonnet-5", "2.1.259"
INGEST_UID, TEST_UID = 2002, 2001
PERSONAS = ("morgan", "alex", "riley")
TOTAL_TURNS = 13539
# The published Mem0 ingestion receipts' hashes of the source id lists; every arm feeds the same history.
SOURCE_IDS_SHA256 = {
    "morgan": "9392631e97eec2eb355242ae4bd0ddfdd86b30c936507bfff62228c492b0e342",
    "alex": "721f137b815ef4ac2a07b2ae0cf5490dd3274fdf3fe96adfce33cab4e30f77d3",
    "riley": "38204b04a3f4f84522091b57a33b9d1486b152c98c9d1a2db1ff42418eaf1cac",
}
CAPTURE_SCHEDULING = "runner_waits_for_empty_worker_queue_v1"
JUDGE_URL, JUDGE_MODEL, JUDGE_PORT = "http://127.0.0.1:18765/v1/chat/completions", "codex:gpt-5.6-sol", 18765
FAKE_TOKEN = "fake-agent-no-token"
RUNTIME = Path("/opt/dolphinbench/published-test-runtime")  # the published runtime.json names this path
DEADLINE_SECONDS = 22 * 3600
WINDOWS_PYTHON = Path("/mnt/c/Users/skf_s/AppData/Local/Programs/Python/Python312/python.exe")
POWERSHELL = Path("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")
TOK_PICK = HERE / "dolphin_tok_pick.py"


def utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def append(path: Path, value: dict) -> None:
    with path.open("a") as stream:
        stream.write(json.dumps(value, sort_keys=True) + "\n")


def corpus(persona: str) -> Path:
    tail = "500k_final/checkpoint" if persona == "morgan" else "500k_final"
    return BENCH / "dolphinbench" / "construction" / "v2" / persona / "release" / tail / "life_sim.yaml"


@dataclasses.dataclass(frozen=True)
class Paths:
    run: str
    persona: str

    @property
    def root(self) -> Path:
        return HOMES / self.run / self.persona

    @property
    def home(self) -> Path:
        return self.root / "home"

    @property
    def project(self) -> Path:
        return self.home / "project"

    @property
    def controller(self) -> Path:
        return self.root / "controller"

    @property
    def receipt(self) -> Path:
        return self.controller / "receipt.json"

    @property
    def seed(self) -> Path:
        return self.root / "seed"

    @property
    def manifest(self) -> Path:
        return self.root / "seed-manifest.json"

    def transcript(self, session_id: str, home: Path | None = None) -> Path:
        home = home or self.home
        folder = "".join(c if c.isalnum() else "-" for c in str(home / "project"))
        return home / ".claude" / "projects" / folder / f"{session_id}.jsonl"


def load_setup() -> dict:
    if os.geteuid() != 0:
        raise SystemExit("run this stage as root in WSL: run-dolphin-official.sh does it")
    if not SETUP.is_file():
        raise SystemExit(f"{SETUP} is missing: run the setup stage first")
    return json.loads(SETUP.read_text())


def use_official(setup: dict, persona: str, agent: str) -> None:
    """Imports resolve to the patched official tree, and every child sees only the sandbox's PATH."""
    os.environ.update({"DOLPHINBENCH_CLAUDE_PERSONA": persona, "DOLPHINBENCH_PERSONA": persona, "LANG": "C.UTF-8",
                       "PYTHONPATH": f"{BASE / 'official'}:{BASE / 'site'}"})
    for path in (str(BASE / "site"), str(BASE / "official")):
        if path not in sys.path:
            sys.path.insert(0, path)
    agent_bin = setup["fake"]["bin"] if agent == "fake" else setup["claude"]["bin"]
    os.environ["PATH"] = ":".join([str(BASE / "bin"), agent_bin, setup["hippo"]["bin"], "/usr/bin", "/bin"])
    resolv = Path("/etc/resolv.conf").read_bytes()
    if (BASE / "etc" / "resolv.conf").read_bytes() != resolv:  # WSL rewrites it at boot
        (BASE / "etc" / "resolv.conf").write_bytes(resolv)


def use_judge(url: str, tag: str) -> None:
    """The grader reads these at import, so this runs before any graders import."""
    os.environ.update({
        "DOLPHINBENCH_JUDGE_BACKEND": "openai", "DOLPHINBENCH_JUDGE_ENDPOINT": f"{url}?tag={tag}",
        "DOLPHINBENCH_JUDGE_MODEL": JUDGE_MODEL, "DOLPHINBENCH_JUDGE_KEY_ENV": "LOCAL_JUDGE_TOKEN",
        "LOCAL_JUDGE_TOKEN": "local-proxy-no-secret", "DOLPHINBENCH_JUDGE_REASONING_EFFORT": "medium",
        "DOLPHINBENCH_JUDGE_PARALLELISM": "1", "DOLPHINBENCH_GRADING_WORKERS": "2"})
    port = int(url.split(":")[2].split("/")[0])
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", port)):
            raise SystemExit(f"no judge proxy on port {port}: start it with run-dolphin-official.sh")


def token_headers(agent: str) -> tuple[str | None, list[dict], int]:
    """Runs the Windows-side token picker: the chosen name, one header row per token (never a value), exit code."""
    if agent == "fake":
        return "fake", [], 0
    win = subprocess.run(["wslpath", "-w", str(TOK_PICK)], capture_output=True, text=True, check=True).stdout.strip()
    done = subprocess.run([str(WINDOWS_PYTHON), win], capture_output=True, text=True, timeout=600, check=False)
    rows = [json.loads(line) for line in done.stderr.splitlines() if line.startswith("{")]
    return done.stdout.strip() or None, rows, done.returncode


def pick_token(agent: str, ledger: Path) -> tuple[str, str]:
    """The token with the most weekly room; with none, sleeps to the earliest reset. The value stays in memory."""
    while True:
        name, rows, code = token_headers(agent)
        append(ledger, {"at": utc(), "picked": name, "headers": rows, "exit": code})
        if agent == "fake":
            return name, FAKE_TOKEN
        if code == 0 and name:
            value = subprocess.run(
                [str(POWERSHELL), "-NoProfile", "-NonInteractive", "-Command",
                 f"[Environment]::GetEnvironmentVariable('{name}','User')"],
                capture_output=True, text=True, check=True).stdout.strip()
            if not value:
                raise SystemExit(f"{name} is empty in the Windows User environment")
            return name, value
        if code != 3:
            raise SystemExit(f"the token picker failed with exit {code}; see {ledger}")
        reset = next((row.get("earliest_reset") for row in rows if row.get("none")), None) or time.time() + 3600
        log.info("no token has room; sleeping until %s", datetime.fromtimestamp(reset + 60, timezone.utc))
        time.sleep(max(60.0, reset + 60 - time.time()))


def as_user(uid: int, command: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(command, user=uid, group=uid, extra_groups=[], capture_output=True, text=True, check=False,
                          **kwargs)


def hippo_dbs(home: Path) -> list[Path]:
    return [path for path in (home / ".hippo" / "hippo.db", home / "project" / ".hippo" / "hippo.db") if path.is_file()]


SQL_AS_USER = ("import json,sqlite3,sys\nout={}\nfor p in sys.argv[2:]:\n"
               " c=sqlite3.connect(p if sys.argv[1]=='rw' else 'file:'+p+'?mode=ro',uri=sys.argv[1]!='rw')\n"
               " out[p]=list(c.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()) if sys.argv[1]=='rw'"
               " else c.execute('select count(*) from memories').fetchone()[0]\n c.close()\nprint(json.dumps(out))")


def store_sql(home: Path, mode: str) -> dict:
    """Counts rows (ro) or checkpoints the WAL (rw) as the ingestion uid, so root never creates a -shm file."""
    done = as_user(INGEST_UID, ["/usr/bin/python3", "-c", SQL_AS_USER, mode, *map(str, hippo_dbs(home))],
                   env={"PATH": "/usr/bin:/bin"}, cwd="/", timeout=600)
    if done.returncode:
        raise RuntimeError(f"store {mode} failed: {done.stderr[-800:]}")
    return json.loads(done.stdout)


def store_counts(home: Path) -> dict:
    notes = home / ".claude" / "auto-memory"
    return {**store_sql(home, "ro"), "auto_memory_files": sum(1 for p in notes.rglob("*") if p.is_file())}


def store_identity(home: Path) -> dict:
    files = {str(path.relative_to(home)): sha256_file(path) for path in hippo_dbs(home)}
    return {"files": files, "sha256": hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()}


def init_event(stdout: str) -> dict:
    for line in stdout.splitlines():
        with contextlib.suppress(ValueError):
            event = json.loads(line)
            if event.get("type") == "system" and event.get("subtype") == "init":
                return event
    return {}


def plugin_config(cc, paths: Paths, setup: dict, agent: str, token: str):
    plugin = setup["plugin"]
    identity = {"sha256": plugin["sha256"], "name": plugin["name"], "plugin_version": plugin["version"],
                "mcp_overlay": plugin["mcp_overlay"], "hippo": setup["hippo"]["version"],
                "hippo_integrity": setup["hippo"]["integrity"], "claude_code": CLAUDE_VERSION,
                "claude_sha256": setup["claude"]["sha256"], "capture_scheduling": CAPTURE_SCHEDULING, "agent": agent}
    return cc.PluginIngestionConfig(
        provider=PROVIDER, model=MODEL, home=paths.home, project=paths.project,
        claude_config_dir=paths.home / ".claude", plugin_source=Path(plugin["dir"]), plugin_identity=identity,
        plugin_settings={"model_cache": setup["models"]["dir"]},
        claude_command=["/usr/bin/python3", str(SANDBOX), "turn", "--", "claude"],
        environment={"CLAUDE_CODE_OAUTH_TOKEN": token}, run_as_user=INGEST_UID, run_as_group=INGEST_UID)


def hippo_init(paths: Paths, setup: dict) -> None:
    """`hippo init` as the ingestion uid in the sandbox, with HOME the still-empty persona home."""
    paths.project.mkdir(parents=True)
    for path in (paths.home, *paths.home.rglob("*")):
        os.chown(path, INGEST_UID, INGEST_UID)
    paths.home.chmod(0o700)
    env = {"PATH": os.environ["PATH"], "LANG": "C.UTF-8", "HOME": str(paths.home),
           "HIPPO_HOME": str(paths.home / ".hippo"), "HIPPO_MODEL_CACHE": setup["models"]["dir"]}
    done = as_user(INGEST_UID, ["/usr/bin/python3", str(SANDBOX), "turn", "--", "hippo", "init", "--no-hooks",
                                "--no-schedule"], env=env, cwd=paths.project, timeout=600)
    (paths.controller / "init.log").write_text(f"exit {done.returncode}\n{done.stdout}\n{done.stderr}")
    if done.returncode:
        raise SystemExit(f"hippo init failed; see {paths.controller / 'init.log'}")


class Turns:
    """The official ingest() callbacks: a store count before each turn, a journal line, and the turn checks."""

    def __init__(self, paths: Paths, token_name: str) -> None:
        self.paths, self.token_name = paths, token_name
        self.counts: dict = {}
        self.started = 0.0

    def before(self, source) -> None:
        self.counts = store_counts(self.paths.home)
        self.started = time.monotonic()

    def journal(self, index: int, source, result) -> None:
        from dolphin_official_report import transcript_hooks
        init = init_event(result.stdout)
        append(self.paths.controller / "journal.jsonl", {
            "index": index, "source_id": source.source_id, "at": utc(),
            "seconds": round(time.monotonic() - self.started, 3), "usage": result.token_usage, "token": self.token_name,
            "claude_code_version": init.get("claude_code_version"), "mcp_servers": init.get("mcp_servers"),
            "drain": drain_report(result.stderr), "memories_before": self.counts,
            "hooks": transcript_hooks([self.paths.transcript(result.session_id)]),
            "sandbox_probe": init.get("sandbox_probe")})

    def verify(self, source, result) -> None:
        version = init_event(result.stdout).get("claude_code_version")
        if version != CLAUDE_VERSION:
            raise RuntimeError(f"Claude Code reported {version}, the run pins {CLAUDE_VERSION}")
        drain = drain_report(result.stderr)
        if drain is None or drain["left"]:
            raise RuntimeError(f"hippo's worker did not finish inside the sandbox: {drain}")
        if queued := sorted(self.paths.home.glob("**/.hippo/sessions/*.queued")):
            raise RuntimeError(f"hippo left queued session work: {queued}")


def adjudicate(paths: Paths, decision: str, automatic: bool, counts: dict) -> None:
    """Records why a retained in-flight marker may be retried, then removes it."""
    marker = paths.controller / "in-flight.json"
    receipt = json.loads(paths.receipt.read_text())
    append(paths.controller / "adjudications.jsonl", {
        "at": utc(), "decision": decision, "automatic": automatic, "receipt_sha256": sha256_file(paths.receipt),
        "marker_sha256": sha256_file(marker), "marker": json.loads(marker.read_text()),
        "completed": len(receipt["completed"]), "pause": receipt.get("pause"), "counts": counts})
    marker.unlink()


def on_limit(paths: Paths, receipt: dict, turns: Turns, agent: str) -> tuple[str, str]:
    """A 429 turn: log the gap; when the store is untouched retry on another token, else stop for review."""
    after = store_counts(paths.home)
    changed = after != turns.counts
    append(paths.controller / "gaps.jsonl", {"at": utc(), **receipt["pause"], "token": turns.token_name,
                                             "store_changed": changed, "before": turns.counts, "after": after})
    if changed:
        raise SystemExit(f"a rate-limited turn changed the store ({turns.counts} -> {after}); review "
                         f"{paths.controller}/traces, then rerun ingest with --recover retry")
    adjudicate(paths, "retry", True, after)
    return pick_token(agent, paths.controller / "tokens.jsonl")


def hold_ingest_lock(paths: Paths):
    """Personas ingest in parallel, so a second ingest on one persona exits before it touches that store."""
    lock = (paths.controller / ".ingest.lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise SystemExit(f"another ingest is writing {paths.root}") from None
    return lock


def ingest_run(args: Namespace, total: int | None = None) -> dict:
    """Ingests --limit more messages (all with 0), or up to `total` completed when the smoke passes one."""
    setup = load_setup()
    use_official(setup, args.persona, args.agent)
    from reference.runtimes import claude_code as cc
    messages, _ = cc.load_morgan_source_messages(corpus(args.persona))
    if cc._source_contract(messages)["source_ids_sha256"] != SOURCE_IDS_SHA256[args.persona]:
        raise SystemExit(f"{args.persona}: the history differs from the published ingestion receipts")
    paths = Paths(args.run, args.persona)
    paths.controller.mkdir(parents=True, exist_ok=True)
    paths.controller.chmod(0o700)
    _lock = hold_ingest_lock(paths)
    token_name, token = pick_token(args.agent, paths.controller / "tokens.jsonl")
    config = plugin_config(cc, paths, setup, args.agent, token)
    if not paths.receipt.exists():
        if paths.home.exists():
            raise SystemExit(f"{paths.home} exists without a receipt; remove the run folder or pick a new --run")
        hippo_init(paths, setup)
        cc.initialize_plugin_receipt(receipt_path=paths.receipt, config=config, messages=messages)
    if args.recover:
        adjudicate(paths, args.recover, False, store_counts(paths.home))
    turns = Turns(paths, token_name)
    receipt = json.loads(paths.receipt.read_text())
    budget = (total - len(receipt["completed"])) if total is not None else (args.limit or len(messages))
    while budget > 0:
        done = len(json.loads(paths.receipt.read_text())["completed"])
        receipt = cc.ingest(receipt_path=paths.receipt, trace_dir=paths.controller / "traces", config=config,
                            messages=messages, max_messages=budget, deadline=time.monotonic() + DEADLINE_SECONDS,
                            verify_turn=turns.verify, before_turn=turns.before, journal_turn=turns.journal)
        budget -= len(receipt["completed"]) - done
        if receipt["status"] == "completed":
            break
        if "pause" in receipt:
            turns.token_name, token = on_limit(paths, receipt, turns, args.agent)
            config = dataclasses.replace(config, environment={"CLAUDE_CODE_OAUTH_TOKEN": token})
    log.info("%s: %d of %d messages ingested", args.persona, len(receipt["completed"]), len(messages))
    return receipt


def seeded(relative: PurePosixPath) -> bool:
    """The official evaluate()'s seed predicate, plus hippo's global store."""
    return (relative.parts[:2] == (".claude", "auto-memory") or relative.parts[:1] in {("project",), (".hippo",)}
            or str(relative) in {"CLAUDE.md", ".claude/CLAUDE.md", ".honcho/config.json"})


def seed_stage(args: Namespace) -> None:
    load_setup()
    paths = Paths(args.run, args.persona)
    receipt = json.loads(paths.receipt.read_text())
    if receipt["status"] != "completed" and not args.partial:
        raise SystemExit("the ingestion is not complete; --partial seeds a proof or smoke run only")
    if (paths.controller / "in-flight.json").exists():
        raise SystemExit("an in-flight marker remains: finish or adjudicate the ingestion first")
    if subprocess.run(["pgrep", "-u", str(INGEST_UID)], capture_output=True, check=False).returncode != 1:
        raise SystemExit(f"uid {INGEST_UID} still runs a process; the worker has not drained")
    if queued := sorted(paths.home.glob("**/.hippo/sessions/*.queued")):
        raise SystemExit(f"hippo has queued session work: {queued}")
    checkpoint = store_sql(paths.home, "rw")
    if any(row[0] for row in checkpoint.values()):
        raise SystemExit(f"a WAL checkpoint was blocked: {checkpoint}")
    if paths.seed.exists():
        raise SystemExit(f"{paths.seed} exists; a seed is made once per ingestion")
    files, skipped = {}, []
    for path in sorted(paths.home.rglob("*")):
        relative = PurePosixPath(path.relative_to(paths.home).as_posix())
        if path.is_symlink() or not path.is_file() or not seeded(relative):
            continue
        if path.name.endswith("-shm") or (path.name.endswith("-wal") and path.stat().st_size == 0):
            skipped.append(str(relative))
            continue
        if path.name.endswith("-wal"):
            raise SystemExit(f"{relative} still holds WAL frames after the checkpoint")
        target = paths.seed / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        target.chmod(0o644)
        files[str(relative)] = sha256_file(target)
    for folder in (paths.seed, *(p for p in paths.seed.rglob("*") if p.is_dir())):
        folder.chmod(0o755)
    if (paths.seed / ".claude" / "projects").exists():
        raise SystemExit("the seed holds Claude session history; the official predicate forbids it")
    manifest = {"created_at": utc(), "partial": receipt["status"] != "completed",
                "completed": len(receipt["completed"]), "receipt_sha256": sha256_file(paths.receipt),
                "checkpoint": checkpoint, "store": store_identity(paths.home), "files": files, "skipped": skipped}
    paths.manifest.write_text(json.dumps(manifest, indent=1))
    log.info("seed %s: %d files, store %s", paths.seed, len(files), manifest["store"]["sha256"][:12])


def hippo_reads(calls: list[dict]) -> int:
    return sum(call.get("tool") in ("Bash", "Read") and ".hippo" in json.dumps(call.get("args")) for call in calls)


@contextlib.contextmanager
def audited(root: Path, paths: Paths, manifest: dict):
    """Wraps run_plugin for this run only: after each test, the master store's hash and the agent's .hippo reads."""
    from reference.execution import claude_agent
    original = claude_agent.run_plugin

    def run_plugin(message, **kwargs):
        result = original(message, **kwargs)
        outputs = sorted(Path(kwargs["test_root"]).glob("agent-output*/sandbox.json"), key=os.path.getmtime)
        sandbox = json.loads(outputs[-1].read_text()) if outputs else {}
        master = store_identity(paths.home)["sha256"]
        append(root / "hippo-audit.jsonl", {
            "test_root": Path(kwargs["test_root"]).name, "ok": result.ok, "status_code": result.status_code,
            "hippo_reads": hippo_reads(result.tool_calls), "master_store_sha256": master,
            "master_unchanged": master == manifest["store"]["sha256"],
            "test_store_changed": sandbox.get("test_store") != sandbox.get("seed_store")})
        return result
    claude_agent.run_plugin = run_plugin
    try:
        yield
    finally:
        claude_agent.run_plugin = original


def prior_rows(paths: Paths, previous: str, expected: dict) -> dict:
    """The official resume rule: answers with driver_ok from earlier runs on the same tests, model and memory."""
    prior, visited = {}, set()
    while previous:
        if Path(previous).name != previous or previous in visited:
            raise SystemExit("invalid previous evaluation run")
        visited.add(previous)
        old = paths.root / "tests" / previous
        old_config = json.loads((old / "configuration.json").read_text())
        if any(old_config.get(key) != value for key, value in expected.items()):
            raise SystemExit("the previous evaluation used different tests, model, or memory")
        for row in json.loads((old / "results.json").read_text()).get("test_results", []):
            if row.get("driver_ok") is True:
                prior.setdefault(row["test_id"], row)
        previous = old_config.get("resumed_from_run") or ""
    return prior


def evaluate(args: Namespace, setup: dict, paths: Paths, run_id: str, previous: str, token_name: str) -> int:
    """claude_plugin_evaluation.evaluate() on this host: same inputs, files, resume rule and runtime call."""
    from harness import run_simulation as runner
    from harness.published_runtime import load
    receipt, manifest = json.loads(paths.receipt.read_text()), json.loads(paths.manifest.read_text())
    config = receipt["config"]
    bundle = HOMES / "bundles" / args.persona
    tests = sorted((bundle / "tests" / args.persona).glob("[0-9][0-9][0-9].yaml"))
    if len(tests) != 200:
        raise SystemExit("expected all 200 published tests")
    runtime_path = bundle / "published-test-runtime" / "runtime.json"
    if set(load(str(RUNTIME / "runtime.json"))["tests"]) != {p.stem for p in tests}:
        raise SystemExit("the published app inputs do not cover the tests")
    test_hashes = {p.name: sha256_file(p) for p in tests}
    runtime_hash = sha256_file(runtime_path)
    expected = {"persona": args.persona, "provider": PROVIDER, "model": config["model"], "reasoning_effort": "medium",
                "plugin_sha256": config["plugin_identity"]["sha256"], "seed_store_sha256": manifest["store"]["sha256"],
                "tests_sha256": test_hashes, "published_test_runtime_sha256": runtime_hash}
    prior = prior_rows(paths, previous, expected)
    remaining = sorted({p.stem for p in tests} - prior.keys())[:args.limit or None]
    if not remaining:
        raise SystemExit("every selected test already has an answer")
    root = paths.root / "tests" / run_id
    root.mkdir(parents=True)
    connection = {"provider": PROVIDER, "home": config["home"], "project": config["project"],
                  "plugin_source": config["plugin_source"], "agent_image": "local-bwrap",
                  "seed_home": str(paths.seed), "model_cache": setup["models"]["dir"]}
    identity_path = root / "memory-connection.json"
    identity_path.write_text(json.dumps({"provider_identity": {"store_sha256": manifest["store"]["sha256"]},
                                         "gateway_config": {}, "claude_plugin": connection}, indent=2))
    (root / "ingestion-receipt.json").write_text(json.dumps(receipt))
    (root / "seed-manifest.json").write_text(json.dumps(manifest))
    (root / "configuration.json").write_text(json.dumps({
        **expected, "run_id": run_id, "claude_account": token_name, "agent": args.agent, "agent_image": "local-bwrap",
        "memory_writes": "HIPPO_READ_ONLY=1 and hippo's five write tools denied; retrieval hooks and tools stay on",
        "native_memory": "fresh copy of the ingested files for each test",
        "tools": "Claude defaults plus official plugin and benchmark apps", "judge": JUDGE_MODEL,
        "seed_partial": manifest["partial"], "setup": setup, "resumed_from_run": previous or None,
        "reused_answers": len(prior), "started_at": utc()}, indent=2))
    with tarfile.open(root / "source-bundle.tar.gz", "w:gz", compresslevel=1) as packed:
        for name in ("harness", "reference", "graders", "mock_mcp", "pricing", "registry"):
            packed.add(BASE / "official" / name, arcname=name, filter=lambda m: None if "__pycache__" in m.name else m)
        packed.add(bundle / "tests", arcname="tests")
        packed.add(bundle / "published-test-runtime", arcname="published-test-runtime")
    run_args = Namespace(agent_runtime="claude", skip_seeding=True, seed_only=False, resume=False, provider=PROVIDER,
                         memory_provider_identity_path=str(identity_path), runtime_config_dir=str(root / "tests"),
                         memory_gateway_python=None, out=str(root / "results.json"), runtime_run_id=run_id,
                         runtime_timeout=1800, model=config["model"], mock_mcp_python=sys.executable)
    run_args.runtime_saved_results = list(prior.values())
    try:
        with audited(root, paths, manifest):
            return runner._run_external_agent_runtime(run_args, runner.resolve_persona_paths(args.persona), {
                "name": f"Claude {PROVIDER} {args.persona}", "test_queries": [{"id": p.stem} for p in tests],
            }, set(remaining))
    finally:
        result_path = root / "results.json"
        if prior and result_path.exists():
            saved = json.loads(result_path.read_text())
            combined = {**prior, **{row["test_id"]: row for row in saved["test_results"]}}
            saved["test_results"] = [combined[key] for key in sorted(combined)]
            passed = sum(bool(row.get("passed")) for row in combined.values())
            saved.setdefault("summary", {}).update(tests_completed=len(combined), tests_passed=passed,
                                                   test_accuracy=passed / len(combined))
            runner._atomic_write_json(result_path, saved)


def test_stage(args: Namespace) -> int:
    setup = load_setup()
    use_official(setup, args.persona, args.agent)
    paths = Paths(args.run, args.persona)
    manifest = json.loads(paths.manifest.read_text())
    if manifest["partial"] and not args.partial:
        raise SystemExit("the seed is partial; only a proof run (--partial) may test it")
    receipt = json.loads(paths.receipt.read_text())
    if receipt["config"]["plugin_identity"]["sha256"] != setup["plugin"]["sha256"]:
        raise SystemExit("the evaluation plugin differs from the ingested plugin")
    if receipt["config"]["plugin_identity"]["agent"] != args.agent:
        raise SystemExit("the tests must use the agent that ingested the history")
    bundle = HOMES / "bundles" / args.persona
    # The app server writes each test's workspace into the runtime, so every stage starts from a fresh copy.
    lock = (HOMES / "bundles" / ".runtime.lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(f"another test stage is using {RUNTIME}") from None
    shutil.rmtree(RUNTIME, ignore_errors=True)
    shutil.copytree(bundle / "published-test-runtime", RUNTIME)
    os.environ.update({"DOLPHINBENCH_TESTS_DIR": str(bundle / "tests" / args.persona), "CLAUDE_CODE_EFFORT_LEVEL":
                       "medium", "DOLPHINBENCH_TEST_RUNTIME_PATH": str(RUNTIME / "runtime.json")})
    use_judge(args.judge_url, f"official-hippo-{args.persona}")
    ledger = paths.root / "tokens.jsonl"
    token_name, os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = pick_token(args.agent, ledger)
    previous = args.resume_from or ""
    while True:
        run_id = f"hippo-{args.persona}-{datetime.now(timezone.utc):%Y%m%dT%H%M%S}"
        code = evaluate(args, setup, paths, run_id, previous, token_name)
        results = json.loads((paths.root / "tests" / run_id / "results.json").read_text())
        if code != 2:
            log.info("%s: %s", run_id, json.dumps(results.get("summary")))
            return code
        append(paths.root / "gaps.jsonl", {"at": utc(), "run_id": run_id, "token": token_name, **results["pause"]})
        token_name, os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = pick_token(args.agent, ledger)
        previous = run_id


def judge_stage(args: Namespace) -> None:
    """The codex judge proxy from dolphin_smoke.py, model pinned; runs as the Windows user's WSL account."""
    if args.kind == "codex" and not os.environ.get("DOLPHIN_CODEX_HOME"):
        raise SystemExit("the codex judge needs DOLPHIN_CODEX_HOME, a clean profile holding a copy of auth.json")
    import dolphin_smoke as smoke
    smoke.JUDGE, smoke.MODEL = args.kind, JUDGE_MODEL.split(":", 1)[1]
    work = BENCH / "runs" / f"official-judge-{args.label}"
    work.mkdir(parents=True, exist_ok=True)
    smoke.serve_judge(work)
    log.info("judge %s (%s) on port %d, work files in %s", args.kind, smoke.MODEL, JUDGE_PORT, work)
    threading.Event().wait()


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    stages = parser.add_subparsers(dest="stage", required=True)
    setup = stages.add_parser("setup", help="install Claude Code, hippo, the embedder, plugin and official tree")
    setup.add_argument("--hippo", required=True, help="npm spec or tarball, for example hippo-memory@3.6.0")
    setup.add_argument("--plugin", required=True, type=Path, help="the hippo Claude Code plugin folder")
    setup.add_argument("--mcp-overlay", action="store_true", help="proof only: add .mcp.json to a plugin without one")
    for name in ("smoke", "ingest", "seed", "test", "report"):
        stage = stages.add_parser(name)
        stage.add_argument("--run", required=True, help="run folder under /srv/dolphin-official")
        stage.add_argument("--persona", choices=PERSONAS, default="morgan")
        if name in ("smoke", "ingest", "test"):
            stage.add_argument("--agent", choices=("claude", "fake"), default="claude")
            stage.add_argument("--limit", type=int, default=20 if name == "smoke" else 0)
        if name in ("smoke", "ingest"):
            stage.add_argument("--recover", choices=("retry",), help="retry the turn an in-flight marker names")
        if name in ("seed", "test"):
            stage.add_argument("--partial", action="store_true", help="proof only: a seed of an unfinished ingestion")
        if name == "test":
            stage.add_argument("--resume-from", default="")
            stage.add_argument("--judge-url", default=JUDGE_URL)
    judge = stages.add_parser("judge", help="serve the judge proxy (not as root)")
    judge.add_argument("--kind", choices=("codex", "stub"), default="codex")
    judge.add_argument("--label", required=True)
    rejudge = stages.add_parser("rejudge-published", help="grade the published Claude Code answers with our judge")
    rejudge.add_argument("--arm", choices=("builtin", "mem0", "honcho"), required=True)
    rejudge.add_argument("--persona", choices=PERSONAS, default="morgan")
    rejudge.add_argument("--limit", type=int, default=0)
    rejudge.add_argument("--judge-url", default=JUDGE_URL)
    args = parser.parse_args()
    if args.stage == "setup":
        from dolphin_official_setup import setup_stage
        setup_stage(args)
    elif args.stage == "ingest":
        ingest_run(args)
    elif args.stage == "seed":
        seed_stage(args)
    elif args.stage == "test":
        return test_stage(args)
    elif args.stage == "judge":
        judge_stage(args)
    else:
        import dolphin_official_report as report
        return {"smoke": report.smoke_stage, "report": report.report_stage,
                "rejudge-published": report.rejudge_stage}[args.stage](args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
