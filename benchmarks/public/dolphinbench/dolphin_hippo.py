"""DolphinBench adapter for hippo-memory v1.52.3, run in WSL: arms hippo and bm25 behind one hippo-mem0-server
store per persona, Claude Code 2.1.259 as the agent. Plan: dolphinbench-feasibility.md. Commands: dolphinbench-runbook.md.
Stages: ingest | run (judge + both arms + check) | arm | judge | check | compare | selftest."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import logging
import os
import re
import shlex
import shutil
import socket
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from collections import Counter
from collections.abc import Iterable, Iterator
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any, NoReturn
from unittest import mock

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
# The benchmark clone, its venv and every output live in hippo-bench, beside this checkout, never inside it.
BENCH = HERE.parents[3] / "hippo-bench"
ROOT = BENCH / "dolphinbench"
SERVER = HERE.parent / "hippo-mem0-server.mjs"
ADAPTER_FILES = ("dolphin_hippo.py", "dolphin_memory.py", "dolphin_smoke.py", "dolphin_fake_claude.py")
# This checkout's files a run executes, compare's bootstrap included; a real-agent run needs every one committed.
OURS = (*(HERE / name for name in ADAPTER_FILES), SERVER, HERE.parent / "evidence_recall.py")
CODEX_PACKAGE = HERE.parents[3] / "AppData/Roaming/npm/node_modules/@openai/codex/package.json"  # dolphin_smoke.CODEX_JS
JUDGE_RUNS = BENCH / "runs"  # the judge proxy's work files, judge-<label>/
BASE = Path.home() / "dolphin"
HIPPO = BASE / "hippo-v1.52.3"
HIPPO_COMMIT = "fcd432e73c9752fce4180269dfb5ff08ea71f389"
CLAUDE = BASE / "claude-code" / "bin" / "claude"
CLAUDE_VERSION = "2.1.259"
STORES, RUNS, LOGS = BASE / "stores", BASE / "runs", BASE / "logs"
WORK = Path("/tmp/dolphin-work")
PERSONAS = ("morgan", "alex", "riley")
ARMS = ("hippo", "bm25")
PORTS = {"ingest": 18800, "hippo": 18801, "bm25": 18802}
SERVER_ARM = {"ingest": "hippo", "hippo": "hippo", "bm25": "bm25"}
JUDGE_PORT = 18765  # dolphin_smoke.PORT
JUDGE_URL = f"http://127.0.0.1:{JUDGE_PORT}/v1/chat/completions"
JUDGE_MODEL = "gpt-5.6-sol"
MODEL = "claude-sonnet-5"
SYNTHETIC = "<synthetic>"  # Claude Code's model name on messages it writes itself, such as API error notices
TOKEN_ENV = "DOLPHIN_CLAUDE_OAUTH_TOKEN"
DRY_RUN_TOKEN = "dry-run-dummy-not-a-credential"
# Built-in tools of the official Claude Code + Mem0 run (evidence rows, available_tools).
BUILTIN_TOOLS = ("Bash", "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit", "EnterWorktree", "ExitWorktree",
                 "ListAgents", "ListMcpResourcesTool", "Monitor", "NotebookEdit", "PushNotification", "Read",
                 "ReadMcpResourceDirTool", "ReadMcpResourceTool", "RemoteTrigger", "ReportFindings", "ScheduleWakeup",
                 "SendMessage", "Skill", "Task", "TaskOutput", "TaskStop", "ToolSearch", "WebFetch", "WebSearch",
                 "Workflow", "Write")
APP_TOOLS, MEMORY_TOOL = "mcp__dolphinbench_apps__*", "mcp__memory__search_memories"
HOOK_LIMIT = 10
TEST_TIMEOUT = 600
# Failed and before-a-turn attempts count toward the cap across passes and resumes, so errors never buy extra tries.
MAX_FAILED_ATTEMPTS, MAX_ATTEMPTS = 3, 9
MAX_RATE_LIMITED, MAX_WAIT_S = 20, 6 * 3600
FULL_TESTS = 200
# One threshold per purpose: the pilot's alarm, and the full run's pause at 2% of an arm's 600 tests.
MAX_CLOSED, MAX_CLOSED_ARM = 1, int(0.02 * FULL_TESTS * len(PERSONAS))
# The driver maps only 429s, rejected rate_limit_events and "rate limit" text; the CLI also says "hit your ... limit".
LIMIT_TEXT = re.compile(r"rate.?limit|usage limit|hit your .{0,40}limit|(session|weekly|spend|opus|sonnet|credit) limit",
                        re.I)
USAGE_KEYS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
MODEL_USAGE_KEYS = ("inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens")
ZERO = dict.fromkeys(USAGE_KEYS, 0)
# Benchmark data and run files; the venv and app servers the agent's own processes run from are left out, so ps passes.
DATASET_PATH = re.compile(r"/dolphin/(runs|stores)/|hippo-bench/(?!\.venv|dolphinbench/mock_mcp/(repair_)?server\.py)"
                          r"|life_sim|facts\.yaml|\b(tests|grades|hooks|apps|deferred)/(morgan|alex|riley)/")
WEB_TOOLS = ("WebSearch", "WebFetch")  # the bare name "dolphinbench" counts only in their arguments
APP_SERVER_NAMES = ("dolphinbench_apps", "dolphinbench-apps")  # tool and server names, not file paths
LOCAL_TOOLS = ("Bash", "Read", "Grep", "Glob")  # listed per pilot test for the hand read
# claude_driver.py:47's list, plus HOME and the WSL interop socket that git.exe and the codex judge need.
CHILD_ENV = ("PATH", "HOME", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "WSL_INTEROP")
OVERRIDES = re.compile(r"(HIPPO|DOLPHINBENCH)_\w*|DOLPHIN_JUDGE_MODEL|(ANTHROPIC|CLAUDE_CODE|OPENAI|CODEX)_\w*MODEL\w*"
                       r"|MAX_THINKING_TOKENS|CLAUDE_CODE_EFFORT_LEVEL")
log = logging.getLogger("dolphin_hippo")


class Deferred(Exception):
    """A test marked for rerun, not graded: its attempts never reached an agent turn, or a usage limit outlasts the
    wait. stop: the arm stops as well, since every later test would hit the same wall."""

    def __init__(self, reason: str, stop: bool) -> None:
        super().__init__(reason)
        self.stop = stop


def child_env(*names: str, **fixed: str) -> dict[str, str]:
    """A child process's environment: the allowlist, the named variables that are set, then fixed values."""
    return {**{name: os.environ[name] for name in (*CHILD_ENV, *names) if name in os.environ}, **fixed}


def judge_label(kind: str) -> str:
    """The judge model every judged grade records; the judge process always runs JUDGE_MODEL."""
    return f"codex:{JUDGE_MODEL}" if kind == "codex" else "stub"


def judge_identity(kind: str) -> dict:
    codex = json.loads(CODEX_PACKAGE.read_text())["version"] if kind == "codex" else None
    return {"kind": kind, "model": judge_label(kind), "codex": codex}


def use_judge(kind: str) -> None:
    """The grader reads its judge settings at import, so this runs before any benchmark import."""
    os.environ.update({
        "DOLPHINBENCH_JUDGE_BACKEND": "openai",
        "DOLPHINBENCH_JUDGE_ENDPOINT": JUDGE_URL,
        "DOLPHINBENCH_JUDGE_MODEL": judge_label(kind),
        "DOLPHINBENCH_JUDGE_KEY_ENV": "LOCAL_JUDGE_TOKEN",
        "LOCAL_JUDGE_TOKEN": "local-proxy-no-secret",
    })
    sys.path.insert(0, str(ROOT))


def user_id(persona: str) -> str:
    return f"dolphin-{persona}"


def store_path(user: str) -> Path:
    """Mirrors rootFor() in hippo-mem0-server.mjs."""
    slug = "".join(c if c.isalnum() or c in "_-" else "_" for c in user)[:40]
    return STORES / f"{slug}-{hashlib.sha256(user.encode()).hexdigest()[:10]}" / ".hippo" / "hippo.db"


def store_digest(persona: str) -> dict:
    path = store_path(user_id(persona))
    with contextlib.closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as db:
        rows = db.execute("SELECT * FROM memories ORDER BY id").fetchall()
    blob = json.dumps(rows, default=str, ensure_ascii=False).encode()
    return {"user_id": user_id(persona), "memories": len(rows), "sha256": hashlib.sha256(blob).hexdigest()}


def http_json(url: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data, {"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def health(port: int, arm: str, read_only: bool) -> None:
    state = http_json(f"http://127.0.0.1:{port}/health")
    if (state.get("status") != "ok" or state.get("arm") != arm or state.get("embeddings") is not False
            or state.get("readOnly") is not read_only):
        raise RuntimeError(f"unexpected hippo server on port {port}: {state}")


def port_free(port: int) -> None:
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            raise SystemExit(f"port {port} is busy: stop the old server first (runbook, teardown)")


def run_text(command: list[str], cwd: Path | None = None) -> str:
    env = child_env(DISABLE_AUTOUPDATER="1")
    return subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, check=True, timeout=120).stdout.strip()


def git(*args: str) -> bytes:
    """This worktree's .git names a Windows gitdir that WSL git cannot open, so Windows git reads it."""
    where = run_text(["wslpath", "-w", str(REPO)])
    return subprocess.run(["git.exe", "-C", where, "--no-optional-locks", *args], env=child_env(),
                          capture_output=True, check=True, timeout=120).stdout


def source_state(agent: str) -> dict:
    """The last commit that changed OURS, and any of them left uncommitted, which a real-agent run refuses."""
    paths = [p.relative_to(REPO).as_posix() for p in OURS]
    status = git("status", "--porcelain", "--untracked-files=all", "--", *paths).decode()
    uncommitted = sorted(line[3:] for line in status.splitlines())
    if agent == "claude" and uncommitted:
        raise SystemExit(f"commit these first, the result checks their hashes against the commit: {', '.join(uncommitted)}")
    return {"commit": git("log", "-1", "--format=%H", "--", *paths).decode().strip(), "uncommitted": uncommitted}


def hippo_identity() -> dict:
    commit = run_text(["git", "-C", str(HIPPO), "rev-parse", "HEAD"])
    if commit != HIPPO_COMMIT or not (HIPPO / "dist" / "search.js").is_file():
        raise SystemExit(f"{HIPPO} must be the built v1.52.3 clone at {HIPPO_COMMIT}, found {commit}")
    return {"version": "1.52.3", "commit": commit, "node": run_text([node(), "--version"]),
            "embeddings": False, "half_life": "shipped default"}


def code_hashes() -> dict[str, str]:
    """runner.py:311-318 pins these for its own CLI, which arm_stage bypasses; ours add OURS and the hippo build the
    server loads. They sit in run.json, so a resume refuses changed code (runner.py:97)."""
    stock = [*(p for part in ("harness", "graders", "mock_mcp", "examples") for p in sorted((ROOT / part).rglob("*.py"))),
             *sorted((ROOT / "examples/reference").glob("*")), ROOT / "harness/benchmark_soul.md",
             *sorted((ROOT / "mock_mcp/manifests").glob("*.yaml")),
             *sorted((ROOT / "mock_mcp/state").glob("*_baseline.json"))]
    ours = [*OURS, *sorted((HIPPO / "dist").rglob("*.js"))]
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [*stock, *ours] if not p.name.startswith("test_")}


def node() -> str:
    path = shutil.which("node") or ""
    if not path or path.startswith("/mnt/"):
        raise SystemExit("WSL node 22 is required on PATH (not the Windows one)")
    return path


@contextlib.contextmanager
def hippo_server(arm: str, label: str) -> Iterator[None]:
    port = PORTS[arm]
    port_free(port)
    LOGS.mkdir(parents=True, exist_ok=True)
    read_only = arm != "ingest"
    # This checkout's server, serving the pinned v1.52.3 build; only ingestion may write to the stores.
    command = [node(), str(SERVER), "--dist", str(HIPPO / "dist"), "--arm", SERVER_ARM[arm], "--host", "127.0.0.1",
               "--port", str(port), "--data-dir", str(STORES), "--embeddings", "0", *(["--read-only"] if read_only else [])]
    with (LOGS / f"{label}-server-{arm}.log").open("a") as out:
        server = subprocess.Popen(command, stdout=out, stderr=subprocess.STDOUT, env=child_env())
    try:
        for _ in range(150):
            if server.poll() is not None:
                raise RuntimeError(f"hippo server exited with {server.returncode}; see {LOGS}")
            with contextlib.suppress(OSError):
                health(port, SERVER_ARM[arm], read_only)
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("hippo server did not answer /health within 30 s")
        yield
    finally:
        server.terminate()
        server.wait(timeout=30)


def blocks(message: dict) -> list[dict]:
    content = message.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [block for block in content or [] if isinstance(block, dict)]


def result_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") if b.get("type") == "text" else f"[{b.get('type')}]"
                     for b in content or [] if isinstance(b, dict))


def absorb(entry: dict, message: dict, seen: set[str]) -> None:
    for block in blocks(message):
        key = json.dumps(block, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        if block.get("type") == "text" and block.get("text"):
            entry["content"] = f"{entry['content']}\n{block['text']}" if entry["content"] else block["text"]
        elif block.get("type") == "tool_use":
            arguments = block.get("input") if isinstance(block.get("input"), dict) else {}
            entry.setdefault("tool_calls", []).append({"id": block["id"], "name": block["name"], "arguments": arguments})
    usage = message.get("usage") or {}
    for key in USAGE_KEYS:
        entry["usage"][key] = max(entry["usage"][key], int(usage.get(key) or 0))


def convert(events: list[dict], user: str, context: str | None) -> list[dict]:
    """Claude stream-json to benchmark messages. Events of one API response share a message id and are merged,
    so usage counts once; sub-agent turns go after the parent's tool results, keeping every call answered in order."""
    main: list[dict] = []
    side: dict[str, list[dict]] = {}
    merged: dict[str, tuple[dict, set[str]]] = {}
    for event in events:
        message, parent = event.get("message"), event.get("parent_tool_use_id")
        if event.get("type") not in ("assistant", "user") or not isinstance(message, dict):
            continue
        target = side.setdefault(parent, []) if parent else main
        if event["type"] == "user":
            target.extend({"role": "tool", "tool_call_id": b["tool_use_id"], "content": result_text(b.get("content"))}
                          for b in blocks(message) if b.get("type") == "tool_result")
            continue
        key = message.get("id") or f"unnamed-{len(merged)}"
        if key not in merged:
            if not parent:
                for group in side.values():
                    main.extend(group)
                side.clear()
            merged[key] = ({"role": "assistant", "content": "", "usage": dict(ZERO)}, set())
            target.append(merged[key][0])
        absorb(merged[key][0], message, merged[key][1])
    for group in side.values():
        main.extend(group)
    head = [{"role": "user", "content": user}]
    return head + ([{"role": "system", "content": context}] if context else []) + main


def close(messages: list[dict], error: str | None) -> list[dict]:
    """End a failed attempt's transcript validly: answer open calls, drop orphan results, add a final turn."""
    out: list[dict] = []
    pending: list[str] = []
    known: set[str] = set()

    def settle() -> None:
        out.extend({"role": "tool", "tool_call_id": i, "content": "[no result: the agent run stopped]"} for i in pending)
        pending.clear()

    for message in messages:
        if message["role"] in ("assistant", "user"):
            settle()
        if message["role"] == "tool":
            if message["tool_call_id"] not in pending:
                continue
            pending.remove(message["tool_call_id"])
        out.append(message)
        calls = [c["id"] for c in message.get("tool_calls", []) if c["id"] not in known]
        known.update(calls)
        pending.extend(calls)
    settle()
    if out[-1]["role"] != "assistant" or out[-1].get("tool_calls"):
        out.append({"role": "assistant", "content": f"[adapter: agent run failed: {error}]", "usage": dict(ZERO)})
    return out


def redact(value: Any, secret: str) -> Any:
    if not secret:
        return value
    return json.loads(json.dumps(value).replace(json.dumps(secret)[1:-1], "[REDACTED]"))


def session_facts(config_dir: Path) -> dict:
    """What Claude's own session files hold: the hook context it injected and the main thread's effort. Only
    attachments count, since the search_memories tool returns the same text as the hook."""
    from harness.claude_driver import _trace_events
    contexts, effort = [], set()
    for path in sorted((config_dir / "projects").rglob("*.jsonl")):
        for line in _trace_events(path.read_text(encoding="utf-8", errors="replace")):
            attachment = line.get("attachment") if isinstance(line.get("attachment"), dict) else {}
            if attachment.get("type") == "hook_additional_context" and attachment.get("hookEvent") == "UserPromptSubmit":
                contexts += [str(text) for text in attachment.get("content") or []]
            if line.get("type") == "assistant" and not line.get("isSidechain") and line.get("effort"):
                effort.add(str(line["effort"]))
    return {"contexts": contexts, "effort": sorted(effort)}


def ended_on_limit(result: Any, events: list[dict]) -> bool:
    """The stream ended on a usage or rate limit: its result says so or, with no result, its last event does.
    A 429 retried earlier in a stream that ended otherwise does not count."""
    final = next((e for e in reversed(events) if e.get("type") == "result"), None)
    if final is not None:
        return final.get("api_error_status") == 429 or bool(
            final.get("is_error") and LIMIT_TEXT.search(str(final.get("result", ""))))
    if not events:
        return result.status_code == 429 or bool(LIMIT_TEXT.search(result.stderr or ""))
    last = events[-1]
    info = last.get("rate_limit_info") if isinstance(last.get("rate_limit_info"), dict) else {}
    message = last.get("message") if isinstance(last.get("message"), dict) else {}
    return (info.get("status") == "rejected" or (last.get("subtype") == "api_retry" and last.get("error_status") == 429)
            or (message.get("model") == SYNTHETIC and bool(LIMIT_TEXT.search(result_text(message.get("content"))))))


def summarize(result: Any, events: list[dict], hook_out: Path, session: dict) -> tuple[dict, str | None]:
    """One attempt's record. Its outcome is usable, limited (its stream ended on a limit: waited out, never
    counted), failed (the agent took a turn and the attempt still has no usable result) or no_turn (it ended before
    the agent's first turn). injected says whether the hook's context is in Claude's own session file."""
    final = next((e for e in reversed(events) if e.get("type") == "result"), {})
    hook = json.loads(hook_out.read_text()) if hook_out.is_file() else {"error": "hook did not run"}
    complete = final.get("is_error") is False
    said = [e for e in events if e.get("type") == "assistant" and isinstance(e.get("message"), dict)]
    acted = any(e["message"].get("model") != SYNTHETIC for e in said)
    outcome = ("usable" if complete and "error" not in hook else "limited" if not complete and ended_on_limit(result, events)
               else "failed" if acted else "no_turn")
    context, seen = (hook.get("context") or "").strip(), "\n".join(session["contexts"])
    attempt = {
        "outcome": outcome, "ok": result.ok, "error": result.error, "complete": complete,
        "hook_error": hook.get("error"), "session_id": result.session_id, "model": result.model,
        "model_usage": final.get("modelUsage") or {},
        "message_models": sorted({e["message"].get("model") for e in said if not e.get("parent_tool_use_id")}
                                 - {None, SYNTHETIC}),
        "effort": session["effort"],
        "injected": ("full" if context and context in seen else
                     "trimmed" if context and context.splitlines()[0] in seen else "missing"),
        "status_code": result.status_code,
        "rate_limit_reset_at": result.rate_limit_reset_at, "retry_after_seconds": result.retry_after_seconds,
        "total_cost_usd": float(final.get("total_cost_usd") or 0.0), "duration_ms": final.get("duration_ms"),
        "num_turns": final.get("num_turns"), "usage": final.get("usage"),
        "memory_results": len(hook.get("results", [])), "hook_seconds": hook.get("seconds"),
        "tool_calls": [call["tool"] for call in result.tool_calls],
    }
    return attempt, hook.get("context")


class HippoAdapter:
    """Ingestion writes each dated history message to the store (D1); tests run Claude with the memory hook and tool."""

    def __init__(self, arm: str, agent: str, run_dir: Path, token: str, judge: str) -> None:
        self.arm, self.agent, self.run_dir, self._token, self.judge = arm, agent, run_dir, token, judge
        self.port = PORTS[arm]
        self.settings = ({"model": MODEL, "reasoning_effort": "medium"} if agent == "claude"
                         else {"model": "dry-run-fake-agent" if agent == "fake" else "direct-store-write"})

    def identity(self) -> dict:
        base = {"adapter": "dolphin_hippo", "version": 1, "arm": self.arm, "hippo": hippo_identity()}
        if self.arm == "ingest":
            return {**base, "ingestion": "dated history message written to the store, no agent turn (D1)"}
        source = source_state(self.agent)  # first, so uncommitted code stops a real run before anything starts
        claude = run_text([str(CLAUDE), "--version"]) if self.agent == "claude" else "fake"
        if self.agent == "claude" and not claude.startswith(CLAUDE_VERSION):
            raise SystemExit(f"{CLAUDE} reports {claude}, expected {CLAUDE_VERSION}")
        return {**base, "agent": self.agent, "claude_code": claude, "model": MODEL, "effort": "medium",
                "builtin_tools": list(BUILTIN_TOOLS), "mcp_tools": [APP_TOOLS, MEMORY_TOOL], "hook_limit": HOOK_LIMIT,
                "timeout_s": TEST_TIMEOUT, "permission_mode": "bypassPermissions", "auto_memory": False,
                "code": code_hashes(), "judge": judge_identity(self.judge), "child_env": list(CHILD_ENV),
                "source": source}

    def freeze(self, persona: str) -> dict:
        return store_digest(persona)

    def verify_checkpoint(self, persona: str, checkpoint: dict) -> None:
        if store_digest(persona) != checkpoint:
            raise ValueError(f"{persona} store changed since its checkpoint")

    def total_cost_usd(self, phase: str) -> float:
        if phase == "ingestion":
            return 0.0
        paths = sorted((self.run_dir / "tests").glob("*/*.json"))
        return round(sum(a["total_cost_usd"] for p in paths for a in json.loads(p.read_text())["attempts"]), 6)

    def run_interaction(self, request: Any) -> Any:
        return self._ingest(request) if request.phase == "ingestion" else self._test(request)

    def _ingest(self, request: Any) -> Any:
        from harness.adapter import InteractionRecord
        moment = datetime.fromisoformat(request.narrative_time)
        if moment.tzinfo is None:
            raise ValueError(f"narrative date without an offset: {request.narrative_time}")
        reply = http_json(f"http://127.0.0.1:{self.port}/memories", {
            "messages": [{"role": "user", "content": request.dated_message}],
            "user_id": user_id(request.persona), "timestamp": moment.timestamp()})
        if len(reply.get("results", [])) != 1:
            raise RuntimeError(f"store did not add session {request.interaction_id}: {reply}")
        return InteractionRecord(self.settings, [{"role": "user", "content": request.dated_message},
                                                 {"role": "assistant", "content": "Noted.", "usage": dict(ZERO)}])

    def _test(self, request: Any) -> Any:
        from harness.adapter import InteractionRecord
        from harness.claude_driver import _trace_events
        env = request.apps["env"]
        state, calls_log = Path(env["DOLPHINBENCH_STATE_PATH"]), Path(env["DOLPHINBENCH_LOG_PATH"])
        initial, started = state.read_bytes(), time.monotonic()
        hooks = self.run_dir / "hooks" / request.persona
        hooks.mkdir(parents=True, exist_ok=True)
        # A deferred test keeps its attempts, so the cap spans passes and resumes and hook files are never reused.
        deferred = self.run_dir / "deferred" / request.persona / f"{request.interaction_id}.json"
        attempts: list[dict] = json.loads(deferred.read_text())["attempts"] if deferred.is_file() else []
        first = len(attempts)
        while True:
            try:
                health(self.port, SERVER_ARM[self.arm], read_only=True)
            except (OSError, ValueError, RuntimeError) as exc:
                self._defer(request, attempts, f"memory server check failed: {exc!r}", stop=True)
            state.write_bytes(initial)  # every attempt starts from the same app state
            calls_log.write_text("")
            hook_out = hooks / f"{request.interaction_id}-{len(attempts)}.json"
            began = time.monotonic()
            result, session = self._claude(request, hook_out)
            events = _trace_events(result.stdout)
            attempt, context = summarize(result, events, hook_out, session)
            attempt["wall_ms"] = round((time.monotonic() - began) * 1000)
            attempts.append(attempt)
            counts, this_pass = (Counter(a["outcome"] for a in group) for group in (attempts, attempts[first:]))
            if attempt["outcome"] == "limited":
                attempt["waited_s"] = self._wait(request, result, attempts, this_pass["limited"])
                continue
            if attempt["outcome"] == "usable":
                break
            if counts["failed"] >= MAX_FAILED_ATTEMPTS or counts["failed"] + counts["no_turn"] >= MAX_ATTEMPTS:
                attempt["closed"] = f"no usable attempt: {counts['failed']} failed, {counts['no_turn']} before a turn"
                break
            if not counts["failed"] and this_pass["no_turn"] >= MAX_FAILED_ATTEMPTS:
                self._defer(request, attempts, f"{this_pass['no_turn']} attempts ended before the agent's first turn, "
                                               f"last error: {attempt['error']}", stop=False)
        messages, app_calls = self._transcript(events, request, context, attempt, calls_log)
        self.verify_checkpoint(request.persona, json.loads(
            (self.run_dir / "checkpoints" / f"{request.persona}.json").read_text()))
        log.info("%s %s/%s: %d attempt(s), outcome=%s, %.0f s, tools=%s", self.arm, request.persona,
                 request.interaction_id, len(attempts), attempt["outcome"], time.monotonic() - started,
                 attempt["tool_calls"])
        # Latency is the graded attempt's own run; waits and earlier attempts stay in `attempts`.
        latency = attempt["duration_ms"] if attempt["duration_ms"] is not None else attempt["wall_ms"]
        record = InteractionRecord(self.settings, messages, duration_ms=latency, attempts=attempts, app_calls=app_calls)
        return InteractionRecord(**redact(asdict(record), self._token))

    def _transcript(self, events: list[dict], request: Any, context: str | None, attempt: dict,
                    calls_log: Path) -> tuple[list[dict], list[dict] | None]:
        from graders.mechanical import load_tool_calls
        from harness.submission import SubmissionError, check_messages, grading_calls
        messages = convert(events, request.dated_message, context)
        if "closed" not in attempt:
            try:
                check_messages(messages, "transcript")
                calls = [{k: c[k] for k in ("tool", "args", "result") if k in c} for c in load_tool_calls(calls_log)]
                if calls:
                    grading_calls({"messages": messages, "app_calls": calls}, "transcript")
                return messages, None
            except SubmissionError as exc:
                # SHORTCUT: a mismatch closes the test at once, graded on no app calls, so sub-agent calls are lost;
                # a retry would favour the arm whose transcripts break more. check counts these apart.
                attempt["closed"] = f"mismatch: {exc}"
        return close(messages, attempt["error"] or attempt["closed"]), []

    def _wait(self, request: Any, result: Any, attempts: list[dict], limited: int) -> float:
        """Sleep out a rate or usage limit and return the seconds waited; a limit past MAX_WAIT_S stops the arm."""
        reset = result.rate_limit_reset_at
        seconds = max(reset - time.time() + 60 if reset else (result.retry_after_seconds or 300), 1)
        if limited > MAX_RATE_LIMITED or seconds > MAX_WAIT_S:
            when = datetime.fromtimestamp(reset).astimezone().isoformat(timespec="minutes") if reset else "unknown"
            self._defer(request, attempts, f"Claude usage limit, resets {when}; resume after it (runbook, resuming)",
                        stop=True)
        log.warning("%s: rate limited, waiting %.0f s", self.arm, seconds)
        time.sleep(seconds)
        return round(seconds, 1)

    def _defer(self, request: Any, attempts: list[dict], reason: str, stop: bool) -> NoReturn:
        """Record why the test was left ungraded; evaluate() reruns it, and so does a resume."""
        from harness.durable_json import save_json
        save_json(self.run_dir / "deferred" / request.persona / f"{request.interaction_id}.json",
                  redact({"reason": reason, "stop": stop, "attempts": attempts}, self._token))
        raise Deferred(reason, stop)

    def _claude(self, request: Any, hook_out: Path) -> tuple[Any, dict]:
        """One attempt, with the facts read from Claude's session file before its per-test home is removed."""
        from harness.claude_driver import run_claude
        box = WORK / self.run_dir.name / request.interaction_id
        shutil.rmtree(box, ignore_errors=True)
        home = box / "home"
        (home / "project").mkdir(parents=True)
        memory = [sys.executable, str(HERE / "dolphin_memory.py")]
        where = ["--url", f"http://127.0.0.1:{self.port}", "--user", user_id(request.persona)]
        mcp_config = box / "mcp.json"
        mcp_config.write_text(json.dumps({"mcpServers": {
            "dolphinbench_apps": request.apps,
            "memory": {"command": memory[0], "args": [memory[1], "mcp", *where], "env": {}}}}))
        hook = shlex.join([*memory, "hook", *where, "--limit", str(HOOK_LIMIT), "--out", str(hook_out)])
        settings = {"autoMemoryEnabled": False,
                    "hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": hook, "timeout": 120}]}]}}
        command = [str(CLAUDE)] if self.agent == "claude" else [sys.executable, str(HERE / "dolphin_fake_claude.py")]
        # run_claude copies this process's environment (claude_driver.py:46), so only the allowlist is left in it.
        allowed = child_env(*(["DOLPHIN_FAKE_FAIL"] if self.agent == "fake" else []))
        try:
            with mock.patch.dict(os.environ, allowed, clear=True):
                result = run_claude(
                    request.message, narrative_time=request.narrative_time, timeout=TEST_TIMEOUT,
                    claude_command=command, claude_config_dir=home / ".claude", mcp_config_path=mcp_config,
                    allowed_mcp_tools=[APP_TOOLS, MEMORY_TOOL], cwd=home / "project", model=MODEL,
                    settings=settings, builtin_tools=list(BUILTIN_TOOLS), permission_mode="bypassPermissions",
                    persist_session=True,  # the session file is the proof the hook's context reached Claude
                    env={"CLAUDE_CODE_OAUTH_TOKEN": self._token, "HOME": str(home),
                         "CLAUDE_CODE_EFFORT_LEVEL": "medium", "DISABLE_AUTOUPDATER": "1"})
            return result, session_facts(home / ".claude")
        finally:
            shutil.rmtree(box, ignore_errors=True)  # the per-test Claude home never outlives the test


def take_token(agent: str) -> str:
    """Read the token once and drop it from this process's environment, so no child inherits the variable."""
    token = os.environ.pop(TOKEN_ENV, "").strip()
    if agent == "fake":
        return DRY_RUN_TOKEN
    if not token:
        raise SystemExit(f"{TOKEN_ENV} is not set; see the runbook (read -rs, then export)")
    return token


def ingest_stage(args: argparse.Namespace) -> None:
    from harness.runner import Runner, run_lock
    from harness.submission import read_release
    full = read_release(ROOT)
    with hippo_server("ingest", "ingest"):
        for persona in args.personas:
            run_dir = RUNS / f"ingest-{persona}"
            if not (run_dir / "run.json").exists() and store_path(user_id(persona)).exists():
                raise SystemExit(f"{store_path(user_id(persona)).parents[1]} exists without its ingest run; remove it")
            adapter = HippoAdapter("ingest", "none", run_dir, "", "none")
            started = time.monotonic()
            with run_lock(run_dir):
                Runner({persona: full[persona]}, run_dir, adapter, identity=adapter.identity(), release_root=ROOT).ingest()
            log.info("ingested %s in %.0f s: %s", persona, time.monotonic() - started, store_digest(persona))


def paused_reason(label: str) -> str | None:
    """A paused run stays paused: no arm resumes it and compare gives it no reading."""
    for path in (RUNS / f"{label}-{arm}-{persona}" / "paused.json" for arm in ARMS for persona in PERSONAS):
        if path.is_file():
            return json.loads(path.read_text())["reason"]
    return None


def evaluate(runner: Any, label: str, arm: str, persona: str) -> str | None:
    """Runner.evaluate (runner.py:240) plus deferral, tagged judge files, the dataset and closure stamps and, in the
    full run, the pause. Returns why the arm stopped early, or None once every test is graded and the cost is collected."""
    from graders import llm_judge
    from harness.durable_json import save_json
    from harness.submission import load_json
    if reason := paused_reason(label):
        return f"PAUSED earlier: {reason}; publish the run as paused"
    checkpoint = runner.directory / "checkpoints" / f"{persona}.json"
    runner.adapter.verify_checkpoint(persona, load_json(checkpoint.read_bytes()))
    runner._saved_cost("ingestion")
    specs = runner.release[persona]["tests"]
    full = len(specs) == FULL_TESTS
    # The pause counts this arm's closed tests over every persona, so earlier personas' closures count too.
    elsewhere = sum("closed" in json.loads(p.read_text()) for other in PERSONAS if other != persona
                    for p in (RUNS / f"{label}-{arm}-{other}" / "grades" / other).glob("*.json")) if full else 0
    closed: set[str] = set()
    todo = specs
    for _ in range(2):  # the second pass reruns what the first deferred
        deferred = []
        for spec in todo:
            item = str(spec["id"]).zfill(3)
            try:
                evidence = runner._execute("tests", persona, spec)
            except Deferred as exc:
                # Nothing was returned or saved, so the marker is not an uncertain interaction.
                runner._path("tests", persona, item).with_suffix(".inflight").unlink(missing_ok=True)
                if exc.stop:
                    return f"STOPPED at {persona}/{item}: {exc}"
                deferred.append(spec)
                continue
            grade_path = runner._path("grades", persona, item)
            if not grade_path.exists():
                llm_judge.OPENAI_DEFAULT_ENDPOINT = f"{JUDGE_URL}?tag={arm}-{persona}-{item}"
                grade = runner._grade(spec, evidence)
                # passed() fails a test that touched the benchmark's files or that the adapter closed.
                if hits := dataset_hits(evidence["row"]):
                    grade["dataset_touch"] = hits
                if closure := evidence["attempts"][-1].get("closed"):
                    grade["closed"] = closure
                save_json(grade_path, grade)
            if "closed" in evidence["attempts"][-1]:
                closed.add(item)
            if full and elsewhere + len(closed) > MAX_CLOSED_ARM:
                reason = (f"the adapter closed {elsewhere + len(closed)} of this arm's tests, over {MAX_CLOSED_ARM} "
                          f"(2% of {FULL_TESTS * len(PERSONAS)}); {persona} so far: {', '.join(sorted(closed))}")
                save_json(runner.directory / "paused.json", {"reason": reason})
                return f"PAUSED: {reason}; publish the run as paused"
        todo = deferred
        if not todo:
            break
    if todo:
        return f"DEFERRED twice: {', '.join(str(s['id']).zfill(3) for s in todo)}; rerun the arm to pick them up"
    runner._collect_cost("tests")
    return None


def arm_stage(args: argparse.Namespace) -> int:
    token = take_token(args.agent)
    from harness.durable_json import save_json
    from harness.runner import Runner, digest, run_lock
    from harness.submission import read_release
    ingest_dir = RUNS / f"ingest-{args.persona}"
    if not (ingest_dir / "checkpoints" / f"{args.persona}.json").is_file():
        raise SystemExit(f"run the ingest stage for {args.persona} first")
    persona = read_release(ROOT)[args.persona]
    release = {args.persona: {**persona, "tests": persona["tests"][:args.tests]}}
    run_dir = RUNS / f"{args.label}-{args.arm}-{args.persona}"
    adapter = HippoAdapter(args.arm, args.agent, run_dir, token, args.judge)
    identity = {**adapter.identity(), "ingest_run": hashlib.sha256((ingest_dir / "run.json").read_bytes()).hexdigest()}
    if not run_dir.exists():
        # The arm directory starts as a copy of the shared ingestion, under its own run identity.
        staging = run_dir.with_name(run_dir.name + ".staging")
        shutil.rmtree(staging, ignore_errors=True)
        shutil.copytree(ingest_dir, staging, ignore=shutil.ignore_patterns("run.json", ".lock"))
        save_json(staging / "run.json", {"version": 1, "release": digest(release), "configuration": identity})
        staging.rename(run_dir)
    with hippo_server(args.arm, args.label), run_lock(run_dir):
        runner = Runner(release, run_dir, adapter, identity=identity, release_root=ROOT)
        runner.allow_paid = True  # D4: reach the local judge proxy without editing the runner
        stopped = evaluate(runner, args.label, args.arm, args.persona)
    if stopped:
        log.error("%s %s: %s", args.arm, args.persona, stopped)
        return 1
    return 0


def judge_stage(args: argparse.Namespace) -> None:
    if args.judge == "codex" and not os.environ.get("DOLPHIN_CODEX_HOME"):
        raise SystemExit("the codex judge needs DOLPHIN_CODEX_HOME, a clean profile holding a copy of auth.json")
    import dolphin_smoke as smoke
    smoke.JUDGE, smoke.MODEL = args.judge, JUDGE_MODEL  # pinned: no variable can swap the judge model
    work = JUDGE_RUNS / f"judge-{args.label}"
    work.mkdir(parents=True, exist_ok=True)
    smoke.serve_judge(work)
    log.info("judge %s (%s) on port %d, work files in %s", args.judge, smoke.MODEL, JUDGE_PORT, work)
    threading.Event().wait()


def wait_port(port: int, process: subprocess.Popen) -> None:
    for _ in range(300):
        if process.poll() is not None:
            raise SystemExit(f"judge exited with {process.returncode}; see {LOGS}")
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.2)
    raise SystemExit(f"judge did not open port {port}")


def run_stage(args: argparse.Namespace) -> int:
    if args.agent == "claude" and not os.environ.get(TOKEN_ENV):
        raise SystemExit(f"{TOKEN_ENV} is not set; see the runbook (read -rs, then export)")
    if args.judge == "codex" and not os.environ.get("DOLPHIN_CODEX_HOME"):
        raise SystemExit("the codex judge needs DOLPHIN_CODEX_HOME, a clean profile holding a copy of auth.json")
    port_free(JUDGE_PORT)
    LOGS.mkdir(parents=True, exist_ok=True)
    me = [sys.executable, str(Path(__file__).resolve())]
    shared = ["--judge", args.judge, "--label", args.label]
    # Each child gets the allowlist and only the secret it needs: the judge the codex profile, the arms the token.
    judge_env = child_env("DOLPHIN_CODEX_HOME")
    arm_env = child_env(TOKEN_ENV if args.agent == "claude" else "DOLPHIN_FAKE_FAIL")
    with (LOGS / f"{args.label}-judge.log").open("a") as out:
        judge = subprocess.Popen([*me, "judge", *shared], env=judge_env, stdout=out, stderr=subprocess.STDOUT)
    try:
        wait_port(JUDGE_PORT, judge)
        arms = {}
        for arm in ARMS:
            with (LOGS / f"{args.label}-{arm}-{args.persona}.log").open("a") as out:
                arms[arm] = subprocess.Popen(
                    [*me, "arm", "--arm", arm, "--agent", args.agent, "--persona", args.persona,
                     "--tests", str(args.tests), *shared], env=arm_env, stdout=out, stderr=subprocess.STDOUT)
        codes = {arm: process.wait() for arm, process in arms.items()}
    finally:
        judge.terminate()
        judge.wait(timeout=30)
    report = check(args.label, args.persona, args.tests)
    print(json.dumps({"exit_codes": codes, **report}, indent=1))
    for arm, code in codes.items():
        if code:
            lines = (LOGS / f"{args.label}-{arm}-{args.persona}.log").read_text().strip().splitlines()
            print(f"{arm} exited {code}: {lines[-1] if lines else '(empty log)'}")
    print(report["gate"])
    return 0 if not any(codes.values()) and report["gate_pass"] else 1


def dataset_hits(row: dict) -> list[str]:
    """Benchmark paths in any tool call or tool result, as "tool: path"; the app server's names are not paths, and
    the benchmark's bare name counts only in a web search or fetch."""
    found = set()
    for message in row["messages"]:
        texts = [(call["name"], json.dumps(call["arguments"])) for call in message.get("tool_calls", [])]
        if message["role"] == "tool":
            texts.append(("result", str(message.get("content", ""))))
        for where, text in texts:
            text = text.lower()
            for name in APP_SERVER_NAMES:
                text = text.replace(name, "")
            found |= {f"{where}: {match.group(0)}" for match in DATASET_PATH.finditer(text)}
            if where in WEB_TOOLS and "dolphinbench" in text:
                found.add(f"{where}: dolphinbench")
    return sorted(found)


def official(persona: str, ids: set[str]) -> dict:
    """The public Claude Code + Sonnet 5 rows for the same tests (plan step 8 compares the pilot with them)."""
    report = {}
    for memory in ("builtin", "mem0", "honcho"):
        path = ROOT / "results/claude-code/claude-sonnet-5" / memory / persona / "tests.json"
        rows = [r for r in json.loads(path.read_text())["tests"] if r["id"] in ids]
        report[memory] = {"tests": len(rows), "passed": sum(bool(r["passed"]) for r in rows),
                          "latency_s_mean": round(statistics.fmean(r["latency_seconds"] for r in rows), 1) if rows else None}
    return report


def passed(grade: dict) -> bool:
    """A test passes when it has checks, every check passes, it touched no benchmark file and was not closed."""
    return (bool(grade["checks"]) and all(c["passed"] for c in grade["checks"])
            and not {"dataset_touch", "closed"} & grade.keys())


def passes(label: str, arm: str, persona: str) -> dict[str, bool]:
    """Test id to pass, from grades/."""
    grades = RUNS / f"{label}-{arm}-{persona}" / "grades" / persona
    return {p.stem: passed(json.loads(p.read_text())) for p in sorted(grades.glob("*.json"))}


def model_flag(attempt: dict) -> bool:
    """An attempt that reached the model with any main-thread model but the pinned one, or not at medium effort.
    Sub-agent and helper models are recorded apart, in helper_models."""
    return attempt["outcome"] in ("usable", "failed") and (
        set(attempt["message_models"]) != {MODEL} or attempt["effort"] != ["medium"])


def model_tokens(attempts: Iterable[dict]) -> Counter:
    """Tokens per model from Claude's modelUsage, input side and output together."""
    total: Counter = Counter()
    for attempt in attempts:
        for model, use in attempt["model_usage"].items():
            total[model] += sum(int(use.get(key) or 0) for key in MODEL_USAGE_KEYS)
    return total


def arm_report(label: str, arm: str, persona: str, full: bool) -> dict:
    """One arm's counts for check. Per-test tokens and searches are the graded attempt's; cost covers every attempt."""
    from harness.runner import JUDGE
    run_dir = RUNS / f"{label}-{arm}-{persona}"
    config = json.loads((run_dir / "run.json").read_text())["configuration"] if (run_dir / "run.json").is_file() else {}
    tests = {p.stem: json.loads(p.read_text()) for p in sorted((run_dir / "tests" / persona).glob("*.json"))}
    grades = {p.stem: json.loads(p.read_text()) for p in sorted((run_dir / "grades" / persona).glob("*.json"))}
    attempts = [a for t in tests.values() for a in t["attempts"]]
    graded = {item: t["attempts"][-1] for item, t in tests.items()}
    ran = {item: a for item, a in graded.items() if a["outcome"] in ("usable", "failed")}
    judge = config.get("judge", {}).get("model")
    local = {item: calls for item, t in tests.items() if (calls := [
        f"{c['name']}: {json.dumps(c['arguments'])[:300]}" for m in t["row"]["messages"]
        for c in m.get("tool_calls", []) if c["name"] in LOCAL_TOOLS])}
    return {
        "agent": config.get("agent"), "tests": len(tests), "grades": len(grades),
        "passed": sum(map(passed, grades.values())), "paused": (run_dir / "paused.json").is_file(),
        "deferred": sorted({p.stem for p in (run_dir / "deferred" / persona).glob("*.json")} - set(tests)),
        "latency_s_mean": round(statistics.fmean(t["row"]["duration_ms"] for t in tests.values()) / 1000, 1)
        if tests else None,
        "limit_wait_s": round(sum(a.get("waited_s", 0) for a in attempts)),
        "attempts": dict(Counter(a["outcome"] for a in attempts)),
        "retry_graded": {item: earlier for item, t in tests.items()
                         if (earlier := [a["outcome"] for a in t["attempts"][:-1] if a["outcome"] != "limited"])},
        "closed_by_adapter": {item: a["closed"] for item, a in graded.items() if "closed" in a},
        "mismatch_closed": sorted(item for item, a in graded.items() if a.get("closed", "").startswith("mismatch")),
        "no_memory_context": sorted(item for item, a in ran.items() if a["memory_results"] == 0),
        "not_injected": {item: a["injected"] for item, a in ran.items() if a["injected"] != "full"},
        "model_flags": sorted({item for item, t in tests.items() for a in t["attempts"] if model_flag(a)}),
        "models": sorted({m for a in attempts for m in a["message_models"]}),
        "helper_models": {m: n for m, n in sorted(model_tokens(attempts).items()) if m != MODEL},
        "judge_mismatch": sorted(item for item, g in grades.items()
                                 if g["settings"] != JUDGE and g["settings"].get("model") != judge),
        "dataset_touches": {item: hits for item, t in tests.items() if (hits := dataset_hits(t["row"]))},
        "local_calls": {} if full else local,
        "tokens_per_test": round(sum(model_tokens(graded.values()).values()) / len(tests)) if tests else None,
        "memory_searches_per_test": round(sum(a["tool_calls"].count(MEMORY_TOOL) for a in graded.values())
                                          / len(tests), 2) if tests else None,
        "cost_usd_api_equivalent": round(sum(a["total_cost_usd"] for a in attempts), 4),
        "costs_file": (run_dir / "costs" / "tests.json").is_file(), "run_dir": str(run_dir)}


def check(label: str, persona: str, expected: int) -> dict:
    """Per-arm counts and the machine gate. Integrity parts hold in every run; the pilot adds alarms on memory found,
    benchmark files and closed tests, which in the full run fail the test in its arm and are listed. Every saved
    file, the judge's included, is byte-scanned for the exported token and the dummy."""
    full = expected == FULL_TESTS
    token = os.environ.get(TOKEN_ENV, "").strip()
    secrets = {DRY_RUN_TOKEN.encode(), token.encode()} - {b""}
    arms = {arm: arm_report(label, arm, persona, full) for arm in ARMS}
    dirs = [RUNS / f"{label}-{arm}-{persona}" for arm in ARMS]
    ids = {p.stem for d in dirs for p in (d / "tests" / persona).glob("*.json")}
    scanned = [p for p in [*LOGS.glob(f"{label}-*"), *WORK.rglob("*"), *(JUDGE_RUNS / f"judge-{label}").rglob("*"),
                           *(p for d in dirs for p in d.rglob("*"))] if p.is_file()]
    leaks = [str(p) for p in scanned if any(secret in p.read_bytes() for secret in secrets)]
    unscanned = not token and any(a["agent"] == "claude" for a in arms.values())

    def failing(key: str) -> str:
        return ", ".join(f"{arm} {' '.join(a[key])}" for arm, a in arms.items() if a[key])

    parts = {
        "complete": ("; ".join(f"{arm} {a['grades']}/{expected} graded{'' if a['costs_file'] else ', no cost file'}"
                               for arm, a in arms.items()),
                     all(a["tests"] == a["grades"] == expected and a["costs_file"] for a in arms.values())),
        "token": (f"not scanned: {TOKEN_ENV} unset" if unscanned else f"{len(leaks)} file(s)", not leaks and not unscanned),
        "memory_context": (failing("not_injected") or "in every session file", not failing("not_injected")),
        "model": (failing("model_flags") or f"{MODEL} at medium effort", not failing("model_flags")),
        "judge": (failing("judge_mismatch") or "every grade", not failing("judge_mismatch")),
    }
    if not full:
        parts |= {
            "memory_found": (failing("no_memory_context") or "every test", not failing("no_memory_context")),
            "dataset_path": (failing("dataset_touches") or "none", not failing("dataset_touches")),
            "closed": (", ".join(f"{arm} {len(a['closed_by_adapter'])}" for arm, a in arms.items()),
                       all(len(a["closed_by_adapter"]) <= MAX_CLOSED for a in arms.values())),
        }
    gate_pass = all(ok for _, ok in parts.values())
    gate = f"GATE: {'PASS' if gate_pass else 'FAIL'} | {label} {persona} | " + " | ".join(
        f"{name} {'ok' if ok else 'FAIL'} ({detail})" for name, (detail, ok) in parts.items())
    return {"gate": gate, "gate_pass": gate_pass, "parts": {name: ok for name, (_, ok) in parts.items()},
            "expected_tests": expected, "token_leak_files": leaks, "arms": arms,
            "official_claude_sonnet_5": official(persona, ids)}


def reading(mean: float, lo: float, hi: float) -> str:
    """Amendment 3's rule, in fractions; rounding keeps 18/600 equal to 0.03."""
    mean, lo, hi = (round(x, 9) for x in (mean, lo, hi))
    if lo > 0 and mean >= 0.03:
        return "beats"
    if hi < 0 and mean <= -0.03:
        return "trails"
    if lo >= -0.03 and hi <= 0.03:
        return "matches"
    return "unresolved"


def pooled(reports: dict[str, dict]) -> dict:
    """One arm over the compared personas: sums, means of the per-persona means (equal sizes), and the per-test
    lists a reader needs."""
    def listed(key: str) -> dict:
        return {persona: r[key] for persona, r in reports.items() if r[key]}

    def mean(key: str) -> float | None:
        values = [r[key] for r in reports.values() if r[key] is not None]
        return round(statistics.fmean(values), 2) if values else None

    helpers: Counter = Counter()
    for r in reports.values():
        helpers.update(r["helper_models"])
    return {"passed": sum(r["passed"] for r in reports.values()), "closed_by_adapter": listed("closed_by_adapter"),
            "retry_graded": listed("retry_graded"), "dataset_touches": listed("dataset_touches"),
            "no_memory_context": listed("no_memory_context"), "latency_s_mean": mean("latency_s_mean"),
            "tokens_per_test": mean("tokens_per_test"), "memory_searches_per_test": mean("memory_searches_per_test"),
            "limit_wait_s": sum(r["limit_wait_s"] for r in reports.values()),
            "cost_usd_api_equivalent": round(sum(r["cost_usd_api_equivalent"] for r in reports.values()), 4),
            "helper_models": dict(sorted(helpers.items()))}


def verify_records(label: str, personas: list[str]) -> None:
    """compare's inputs: one configuration over arms and personas, the real agent and the codex judge, and each of
    OURS recorded with the hash of the committed file, which is also the file compare runs now."""
    configs = [json.loads((RUNS / f"{label}-{arm}-{persona}" / "run.json").read_text())["configuration"]
               for arm in ARMS for persona in personas]
    shared = [{k: v for k, v in c.items() if k not in ("arm", "ingest_run")} for c in configs]
    config, problems = configs[0], []
    if any(s != shared[0] for s in shared):
        problems.append("the arms or personas ran different configurations")
    if config.get("agent") != "claude" or config.get("judge", {}).get("model") != judge_label("codex"):
        problems.append(f"agent {config.get('agent')} with judge {config.get('judge')}, not claude with codex")
    source = config.get("source", {})
    if source.get("uncommitted") != []:
        problems.append(f"uncommitted at run time: {source.get('uncommitted')}")
    commit = source.get("commit", "")
    for path in OURS:
        rel = path.relative_to(REPO).as_posix()
        try:
            committed = hashlib.sha256(git("cat-file", "blob", f"{commit}:{rel}")).hexdigest() if commit else "missing"
        except subprocess.CalledProcessError:
            committed = "missing"
        if not config.get("code", {}).get(str(path)) == committed == hashlib.sha256(path.read_bytes()).hexdigest():
            problems.append(f"{rel} differs between the record, commit {commit[:12] or '(none)'} and this checkout")
    if problems:
        raise SystemExit(f"compare refused: {'; '.join(problems)}. Compare from this checkout at the recorded commit.")


def compare(label: str, personas: list[str]) -> dict:
    """hippo minus bm25 pass rate, paired by test, with the public benchmarks' bootstrap (4,000 draws, seed 1).
    Refuses a paused run, a failing gate and records that differ from the commit. Only "all" gets a reading; per
    persona, without Morgan 1-20 (the pilot's tests) and without tests either arm closed are secondary."""
    if reason := paused_reason(label):
        raise SystemExit(f"compare refused: the run paused ({reason}); publish it as paused, with no reading")
    reports, refused = {}, []
    for persona in personas:
        reports[persona] = check(label, persona, FULL_TESTS)
        print(reports[persona]["gate"])
        if not reports[persona]["gate_pass"]:
            refused.append(persona)
    if refused:
        raise SystemExit(f"compare refused: the gate fails for {', '.join(refused)}; it needs every part ok and "
                         f"{FULL_TESTS} graded tests per arm and persona (GATE lines above)")
    verify_records(label, personas)
    sys.path.insert(0, str(HERE.parent))
    from evidence_recall import boot
    diffs, closed = {}, set()
    for persona in personas:
        hippo, bm25 = passes(label, "hippo", persona), passes(label, "bm25", persona)
        if hippo.keys() != bm25.keys():
            raise SystemExit(f"{persona}: the arms graded different tests")
        diffs |= {(persona, t): int(hippo[t]) - int(bm25[t]) for t in hippo}
        closed |= {(persona, t) for a in reports[persona]["arms"].values() for t in a["closed_by_adapter"]}
    subsets = {"all": list(diffs), **{p: [k for k in diffs if k[0] == p] for p in personas},
               "without_morgan_1_20": [k for k in diffs if not (k[0] == "morgan" and int(k[1]) <= 20)],
               "excluding_closed": [k for k in diffs if k not in closed]}
    report: dict[str, Any] = {}
    for name, keys in subsets.items():
        rows = [diffs[k] for k in keys]
        if not rows:
            continue
        mean, lo, hi = boot([float(d) for d in rows])
        report[name] = {"tests": len(rows), "hippo_only": rows.count(1), "bm25_only": rows.count(-1),
                        "diff_pp": round(100 * mean, 2), "ci95_pp": [round(100 * lo, 2), round(100 * hi, 2)],
                        "reading": reading(mean, lo, hi) if name == "all" else "secondary"}
    report["arms"] = {arm: pooled({p: reports[p]["arms"][arm] for p in personas}) for arm in ARMS}
    return report


def selftest() -> None:
    """Converter and redaction checks on a synthetic trace (split events, parallel calls, a sub-agent), then
    attempt outcomes, dataset hits, the gate and the compare refusal on files in a temporary directory."""
    from harness.submission import check_messages
    usage = {"input_tokens": 3, "output_tokens": 7, "cache_read_input_tokens": 5, "cache_creation_input_tokens": 0}

    def said(mid: str, block: dict, parent: str | None = None) -> dict:
        return {"type": "assistant", "parent_tool_use_id": parent, "message": {"id": mid, "content": [block], "usage": usage}}

    def answer(tid: str, parent: str | None = None) -> dict:
        content = [{"type": "tool_result", "tool_use_id": tid, "content": [{"type": "text", "text": f"out {tid}"}]}]
        return {"type": "user", "parent_tool_use_id": parent, "message": {"content": content}}

    def use(tid: str, name: str) -> dict:
        return {"type": "tool_use", "id": tid, "name": name, "input": {"q": tid}}

    secret = "selftest-secret-value"
    events = [said("m1", {"type": "text", "text": "Checking."}), said("m1", use("t1", "Task")),
              said("m1", use("t2", MEMORY_TOOL)), said("s1", use("t3", "Read"), "t1"), answer("t3", "t1"),
              said("s2", {"type": "text", "text": "sub-agent done"}, "t1"), answer("t2"), answer("t1"),
              said("m2", {"type": "text", "text": f"Done {secret}"}), {"type": "result", "is_error": False}]
    messages = convert(events, "[2026-09-14] hi", "memory context")
    check_messages(messages, "selftest")
    roles = [m["role"] for m in messages]
    assert roles == ["user", "system", "assistant", "tool", "tool", "assistant", "tool", "assistant", "assistant"], roles
    assert messages[2]["usage"]["output_tokens"] == 7 and len(messages[2]["tool_calls"]) == 2
    assert secret not in json.dumps(redact(messages, secret))
    check_messages(close(messages[:3], "timeout"), "closed")
    check_messages(close(messages[:4], "timeout"), "closed")
    cases = [((18 / 600, 1 / 600, 0.06), "beats"), ((17 / 600, 1 / 600, 0.06), "unresolved"),
             ((-18 / 600, -0.06, -1 / 600), "trails"), ((0.01, -18 / 600, 18 / 600), "matches"),
             ((0.01, -0.031, 0.02), "unresolved"), ((0.02, 0.005, 0.029), "matches")]
    assert [reading(*args) for args, _ in cases] == [want for _, want in cases]
    for name in ("HIPPO_FAKE_NOW", "HIPPO_ABLATE_DECAY", "DOLPHINBENCH_JUDGE_MODEL", "DOLPHIN_JUDGE_MODEL",
                 "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL", "MAX_THINKING_TOKENS"):
        assert OVERRIDES.fullmatch(name), name
    for name in (TOKEN_ENV, "DOLPHIN_CODEX_HOME", "DOLPHIN_FAKE_FAIL", "CLAUDE_CONFIG_DIR", "PATH"):
        assert not OVERRIDES.fullmatch(name), name
    with tempfile.TemporaryDirectory() as tmp:
        # The token variable is swapped for a dummy name, so the selftest never reads a real token.
        saved = {name: globals()[name] for name in ("RUNS", "LOGS", "WORK", "JUDGE_RUNS", "TOKEN_ENV", "git")}
        globals().update(RUNS=Path(tmp) / "runs", LOGS=Path(tmp) / "logs", WORK=Path(tmp) / "work",
                         JUDGE_RUNS=Path(tmp) / "judge", TOKEN_ENV="DOLPHIN_SELFTEST_TOKEN")
        try:
            selftest_outcomes(Path(tmp))
            selftest_gate()
            selftest_pause()
        finally:
            globals().update(saved)
    print("selftest ok")


def selftest_outcomes(tmp: Path) -> None:
    """Outcomes follow how the stream ended; injection is read from Claude's session file, attachments only; the
    detector passes the agent's own environment, config and processes and fires on real reads."""
    from types import SimpleNamespace
    context = "Memories from the user's past conversations:\n1. small latte\n2. pickup"
    hook_out = tmp / "hook.json"
    hook_out.write_text(json.dumps({"results": [{"memory": "m"}], "context": context, "seconds": 0.1}))

    def attempt(*events: dict, status: int | None = None, seen: tuple[str, ...] = (context,)) -> dict:
        result = SimpleNamespace(ok=False, error="x", session_id=None, model=None, status_code=status, stderr="",
                                 rate_limit_reset_at=None, retry_after_seconds=None, tool_calls=[])
        return summarize(result, list(events), hook_out, {"contexts": list(seen), "effort": ["medium"]})[0]

    def said(text: str, model: str) -> dict:
        return {"type": "assistant", "message": {"id": text, "model": model, "content": [{"type": "text", "text": text}]}}

    def ended(text: str) -> dict:
        return {"type": "result", "is_error": True, "result": text}

    limit, retry = said("You've hit your session limit", SYNTHETIC), {"type": "system", "subtype": "api_retry",
                                                                       "error_status": 429}
    turn, done = said("Looking.", MODEL), {"type": "result", "is_error": False}
    cases = [((limit, ended("You've hit your session limit")), None, "limited"), ((retry,), None, "limited"),
             ((), 429, "limited"), ((retry, turn), None, "failed"), ((turn,), 429, "failed"),
             ((said("API Error: 500", SYNTHETIC), ended("API Error: 500")), None, "no_turn"), ((), None, "no_turn"),
             ((turn,), None, "failed"), ((turn, done), None, "usable")]
    assert [attempt(*events, status=status)["outcome"] for events, status, _ in cases] == [c[2] for c in cases]
    assert [attempt(turn, done, seen=seen)["injected"] for seen in ((context,), (context.splitlines()[0],), ())] == [
        "full", "trimmed", "missing"]
    session = tmp / "config" / "projects" / "-tmp-home-project" / "s.jsonl"
    session.parent.mkdir(parents=True)
    lines = [{"type": "attachment", "attachment": {"type": "hook_additional_context", "content": [context],
                                                   "hookEvent": "UserPromptSubmit"}},
             {"type": "attachment", "attachment": {"type": "hook_additional_context", "content": ["x"],
                                                   "hookEvent": "PostToolUse"}},
             {"type": "user", "message": {"content": [{"type": "tool_result", "content": context}]}},
             {"type": "assistant", "effort": "medium", "isSidechain": False, "message": {}},
             {"type": "assistant", "effort": "high", "isSidechain": True, "message": {}}]
    session.write_text("\n".join(map(json.dumps, lines)))
    assert session_facts(tmp / "config") == {"contexts": [context], "effort": ["medium"]}

    def hits(name: str, arguments: dict, output: str) -> list[str]:
        return dataset_hits({"messages": [
            {"role": "assistant", "content": "", "tool_calls": [{"id": "x", "name": name, "arguments": arguments}]},
            {"role": "tool", "tool_call_id": "x", "content": output}]})

    # The review's probes: env, ls ~/.claude and ps are benign; the other arm's hook file by a relative path is not.
    benign = [("Bash", {"command": "env"}, "PATH=/mnt/c/u/hippo-bench/.venv-dolphin-wsl/bin:/usr/bin\n"
                                           "DOLPHINBENCH_JUDGE_BACKEND=openai\nHOME=/tmp/dolphin-work/t-hippo-morgan/1/home"),
              ("Bash", {"command": "ls -la ~/.claude"}, "dolphinbench-native-memory-settings.json\nprojects"),
              ("Bash", {"command": "ps aux"}, "/mnt/c/u/hippo-bench/.venv-dolphin-wsl/bin/python "
                                              "/mnt/c/u/hippo-bench/dolphinbench/mock_mcp/server.py\nnode "
                                              "hippo-mem0-server.mjs --dist /home/u/dolphin/hippo-v1.52.3/dist "
                                              "--data-dir /home/u/dolphin/stores --read-only"),
              ("mcp__dolphinbench_apps__place_order", {"notes": "pickup"}, "ok from dolphinbench_apps")]
    assert not any(hits(*case) for case in benign), [hits(*case) for case in benign]
    relative = ("Bash", {"command": "cd /home/u/dolphin && cat runs/t-bm25-morgan/hooks/morgan/007-0.json"}, "{}")
    assert hits(*relative) == ["Bash: hooks/morgan/"], hits(*relative)
    real = [("Bash", {"command": "cat /home/u/dolphin/runs/t-bm25-morgan/state.json"}, "{}"),
            ("Read", {"file_path": "/tmp/x"}, "see /mnt/c/u/hippo-bench/dolphinbench/mock_mcp/manifests/morgan.yaml"),
            ("Bash", {"command": "ls"}, "facts.yaml"), ("WebSearch", {"query": "DolphinBench answers"}, "")]
    assert all(hits(*case) for case in real), [hits(*case) for case in real]


def selftest_gate() -> None:
    """A clean full run passes and compares. The full-run gate is integrity only and lists closed and touching tests,
    which fail; the pilot adds its alarms; compare refuses a missing grade, a changed file, a dry-run record and a
    paused run; a real-agent run refuses uncommitted files."""
    status = {"now": b""}

    def fake_git(*args: str) -> bytes:
        if args[0] == "cat-file":
            return (REPO / args[-1].split(":", 1)[1]).read_bytes()
        return status["now"] if args[0] == "status" else b"c0ffee\n"

    def put(path: Path, value: dict | str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value if isinstance(value, str) else json.dumps(value))

    def arm_dir(arm: str) -> Path:
        return RUNS / f"t-{arm}-morgan"

    def put_test(arm: str, n: int, *attempts: dict, messages: tuple = (), passed: bool = True, **stamps: Any) -> None:
        row = {"test_id": f"{n:03d}", "messages": list(messages), "duration_ms": 1000}
        put(arm_dir(arm) / "tests" / "morgan" / f"{n:03d}.json", {"settings": {}, "row": row, "attempts": list(attempts)})
        put(arm_dir(arm) / "grades" / "morgan" / f"{n:03d}.json",
            {"checks": [{"check": 0, "passed": passed}], "settings": {"model": judge_label("codex")}, **stamps})

    def configure(**change: Any) -> None:
        for arm in ARMS:
            put(arm_dir(arm) / "run.json", {"version": 1, "release": "r",
                                            "configuration": {**config, "arm": arm, "ingest_run": "i", **change}})

    def refusal() -> str:
        try:
            compare("t", ["morgan"])
        except SystemExit as exc:
            return str(exc)
        raise AssertionError("compare ran on a run it must refuse")

    globals()["git"] = fake_git
    config = {"agent": "claude", "judge": {"kind": "codex", "model": judge_label("codex"), "codex": "0"},
              "code": {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in OURS},
              "source": {"commit": "c0ffee", "uncommitted": []}}
    usable = {"outcome": "usable", "memory_results": 3, "message_models": [MODEL], "effort": ["medium"],
              "injected": "full", "tool_calls": [MEMORY_TOOL], "total_cost_usd": 0.0, "duration_ms": 1000,
              "model_usage": {MODEL: {"inputTokens": 10, "outputTokens": 5}, "helper-model": {"inputTokens": 2}}}
    configure()
    for arm in ARMS:
        for n in range(1, FULL_TESTS + 1):
            put_test(arm, n, usable, passed=arm == "hippo" or n % 2 == 0)
        put(arm_dir(arm) / "costs" / "tests.json", {"total_cost_usd": 0.0})
    assert f"token FAIL (not scanned: {TOKEN_ENV} unset)" in check("t", "morgan", FULL_TESTS)["gate"]
    with mock.patch.dict(os.environ, {TOKEN_ENV: "selftest-token-value"}):
        assert check("t", "morgan", FULL_TESTS)["gate"].startswith("GATE: PASS")
        report = compare("t", ["morgan"])
        assert report["all"]["hippo_only"] == FULL_TESTS // 2 and report["without_morgan_1_20"]["tests"] == 180
        arm = report["arms"]["hippo"]
        assert arm["helper_models"] == {"helper-model": 2 * FULL_TESTS} and arm["tokens_per_test"] == 17
        grade = arm_dir("bm25") / "grades" / "morgan" / "200.json"
        kept = grade.read_text()
        grade.unlink()
        assert "the gate fails" in refusal()
        put(grade, kept)
        configure(code={**config["code"], str(SERVER): "0" * 64})
        assert "hippo-mem0-server.mjs differs" in refusal()
        configure(agent="fake")
        assert "not claude with codex" in refusal()
        configure()
        put(arm_dir("hippo") / "paused.json", {"reason": "closed 13"})
        assert "the run paused" in refusal()
        (arm_dir("hippo") / "paused.json").unlink()
    failed = {**usable, "outcome": "failed"}
    capped = "no usable attempt: 3 failed, 0 before a turn"
    touch = {"role": "assistant", "content": "", "tool_calls": [
        {"id": "b", "name": "Bash", "arguments": {"command": "cat /home/u/dolphin/runs/t-bm25-morgan/state.json"}}]}
    put_test("bm25", 2, {**usable, "closed": "mismatch: app calls"}, closed="mismatch: app calls")
    put_test("bm25", 4, failed, failed, {**failed, "closed": capped}, closed=capped)
    put_test("hippo", 3, {**usable, "memory_results": 0})
    put_test("hippo", 4, usable, messages=(touch,), dataset_touch=["Bash: /dolphin/runs/"])
    put_test("hippo", 5, {**usable, "message_models": [MODEL, "claude-opus-5"]})
    put_test("hippo", 6, {**usable, "injected": "trimmed"})
    put_test("hippo", 8, failed, usable)
    put(arm_dir("hippo") / "grades" / "morgan" / "007.json", {"checks": [{"check": 0, "passed": True}],
                                                              "settings": {"model": "stub"}})
    put(JUDGE_RUNS / "judge-t" / "codex-x.log", f"leaked {DRY_RUN_TOKEN}")
    with mock.patch.dict(os.environ, {TOKEN_ENV: "selftest-token-value"}):
        report, pilot = check("t", "morgan", FULL_TESTS), check("t", "morgan", 20)
    assert report["parts"] == {"complete": True, "token": False, "memory_context": False, "model": False,
                               "judge": False}, report["parts"]
    hippo, bm25 = report["arms"]["hippo"], report["arms"]["bm25"]
    assert list(bm25["closed_by_adapter"]) == ["002", "004"] and bm25["mismatch_closed"] == ["002"]
    assert hippo["no_memory_context"] == ["003"] and hippo["dataset_touches"] == {"004": ["Bash: /dolphin/runs/"]}
    assert hippo["model_flags"] == ["005"] and hippo["not_injected"] == {"006": "trimmed"}
    assert hippo["judge_mismatch"] == ["007"] and hippo["retry_graded"] == {"008": ["failed"]}
    assert not hippo["local_calls"] and list(pilot["arms"]["hippo"]["local_calls"]) == ["004"]
    assert not any(passes("t", arm, "morgan")[n] for arm, n in (("bm25", "002"), ("bm25", "004"), ("hippo", "004")))
    assert not any(pilot["parts"][name] for name in ("memory_found", "dataset_path", "closed")), pilot["parts"]
    status["now"] = b" M benchmarks/public/dolphinbench/dolphin_hippo.py\n"
    assert source_state("fake") == {"commit": "c0ffee", "uncommitted": ["benchmarks/public/dolphinbench/dolphin_hippo.py"]}
    try:
        source_state("claude")
        raise AssertionError("a real-agent run started on uncommitted code")
    except SystemExit as exc:
        assert "commit these first" in str(exc)


def selftest_pause() -> None:
    """The full run pauses once an arm's closed tests exceed 2% over its personas and stays paused; a pilot never
    pauses."""
    from types import SimpleNamespace

    from harness.durable_json import save_json

    def runner(label: str, persona: str, tests: int, closed: int) -> SimpleNamespace:
        directory = RUNS / f"{label}-hippo-{persona}"
        save_json(directory / "checkpoints" / f"{persona}.json", {})

        def execute(phase: str, who: str, spec: dict) -> dict:
            closure = {"closed": "no usable attempt: 3 failed, 0 before a turn"} if spec["id"] <= closed else {}
            return {"row": {"messages": []}, "attempts": [closure]}

        return SimpleNamespace(
            directory=directory, adapter=SimpleNamespace(verify_checkpoint=lambda *_: None), _execute=execute,
            release={persona: {"tests": [{"id": n} for n in range(1, tests + 1)]}}, _saved_cost=lambda _: None,
            _path=lambda kind, who, item: directory / kind / who / f"{item}.json", _collect_cost=lambda _: None,
            _grade=lambda *_: {"checks": [{"check": 0, "passed": True}], "settings": {"model": "stub"}})

    save_json(RUNS / "f-hippo-morgan" / "grades" / "morgan" / "001.json", {"checks": [], "closed": "mismatch: x"})
    stopped = evaluate(runner("f", "alex", FULL_TESTS, 20), "f", "hippo", "alex") or ""
    assert stopped.startswith(f"PAUSED: the adapter closed {MAX_CLOSED_ARM + 1} of this arm's tests"), stopped
    assert stopped.endswith("alex so far: " + ", ".join(f"{n:03d}" for n in range(1, MAX_CLOSED_ARM + 1))
                            + "; publish the run as paused"), stopped
    assert (evaluate(runner("f", "alex", FULL_TESTS, 20), "f", "hippo", "alex") or "").startswith("PAUSED earlier")
    assert evaluate(runner("p", "morgan", 20, 3), "p", "hippo", "morgan") is None


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    stages = parser.add_subparsers(dest="stage", required=True)
    stages.add_parser("ingest").add_argument("--personas", nargs="+", choices=PERSONAS, default=list(PERSONAS))
    for name in ("run", "arm", "judge", "check"):
        stage = stages.add_parser(name)
        stage.add_argument("--label", required=True, help="run name, for example pilot or dryrun")
        if name != "judge":
            stage.add_argument("--persona", choices=PERSONAS, default="morgan")
            stage.add_argument("--tests", type=int, default=20, help="first N tests of the persona")
        if name in ("run", "arm"):
            stage.add_argument("--agent", choices=("claude", "fake"), default="claude")
        if name != "check":
            stage.add_argument("--judge", choices=("codex", "stub"), default="codex")
        if name == "arm":
            stage.add_argument("--arm", choices=ARMS, required=True)
    compare_stage = stages.add_parser("compare")
    compare_stage.add_argument("--label", required=True)
    compare_stage.add_argument("--personas", nargs="+", choices=PERSONAS, default=list(PERSONAS))
    stages.add_parser("selftest")
    args = parser.parse_args()
    if args.stage in ("ingest", "run", "arm", "judge") and (found := sorted(filter(OVERRIDES.fullmatch, os.environ))):
        raise SystemExit(f"unset {', '.join(found)}: the run pins its models and hippo settings (runbook, environment)")
    use_judge(getattr(args, "judge", "stub"))
    if args.stage == "ingest":
        ingest_stage(args)
    elif args.stage == "arm":
        return arm_stage(args)
    elif args.stage == "judge":
        judge_stage(args)
    elif args.stage == "run":
        return run_stage(args)
    elif args.stage == "check":
        report = check(args.label, args.persona, args.tests)
        print(json.dumps(report, indent=1))
        print(report["gate"])
        return 0 if report["gate_pass"] else 1
    elif args.stage == "compare":
        print(json.dumps(compare(args.label, args.personas), indent=1))
    else:
        selftest()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
