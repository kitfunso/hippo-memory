from __future__ import annotations

import copy
import functools
import json
import logging
import math
import ntpath
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path
from subprocess import Popen
from types import SimpleNamespace
from typing import Any, Callable, Optional

from agent.memory_provider import MemoryProvider, ctx_bound

logger = logging.getLogger(__name__)

TIMEOUTS = {"context": 6, "recall": 6, "remember": 6, "outcome": 6, "capture": 30}
EXIT_WATCHDOG_DEFAULT_S = 30.0
NO_WATCHDOG_DEADLINE_S = 30.0
HERMES_PRE_SHUTDOWN_S = 15.0
SHUTDOWN_MARGIN_S = 3.0
LAUNCHER_FILE = Path(__file__).with_name("launcher.json")
CONTEXT_ARGS = ("--pinned-only", "--include-recent", "5", "--format", "additional-context")
RECALL_ARGS = ("--json", "--budget", "1500")
REMEMBER_ARGS = ("--tag", "hermes")

OPS = ("prefetch", "recall", "remember", "outcome", "capture")
LOCAL_PLATFORMS = frozenset({"cli", "tui", "desktop"})
LOCAL_SOURCES = frozenset({"cli", "tui", "desktop", "oneshot"})
CONTEXT_RULES = {
    "primary": (True, True, True, True, True),
    "subagent": (False, True, False, False, False),
    "cron": (True, True, False, False, False),
    "flush": (False, False, False, False, False),
}
TOOL_OPS = {"hippo_recall": "recall", "hippo_remember": "remember", "hippo_outcome": "outcome"}


def _schema(name: str, description: str, prop: str, kind: str) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "parameters": {"type": "object", "properties": {prop: {"type": kind}}, "required": [prop]},
    }


TOOL_SCHEMAS = (
    _schema("hippo_recall", "Search hippo memory.", "query", "string"),
    _schema("hippo_remember", "Save one lesson or fact.", "text", "string"),
    _schema("hippo_outcome", "Say if your last hippo_recall helped.", "good", "boolean"),
)


@dataclass(frozen=True)
class Result:
    code: int
    out: str
    err: str


def _read_json(path: Path) -> Optional[dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        logger.warning("hippo: %s is unreadable: %s", path, exc)
        return None
    return data if isinstance(data, dict) else None


def _launcher_record() -> Optional[dict[str, str]]:
    rec = _read_json(LAUNCHER_FILE)
    if not rec:
        return None
    node, script = rec.get("node"), rec.get("script")
    if isinstance(node, str) and node and isinstance(script, str) and script:
        return {"node": node, "script": script}
    logger.warning("hippo: %s needs node and script paths", LAUNCHER_FILE)
    return None


def capture_deadline_s() -> float:
    try:
        watchdog = float(os.environ.get("HERMES_EXIT_WATCHDOG_S", EXIT_WATCHDOG_DEFAULT_S))
    except ValueError:
        watchdog = EXIT_WATCHDOG_DEFAULT_S
    if not 0 < watchdog < math.inf:
        return NO_WATCHDOG_DEADLINE_S
    return min(max(1.0, watchdog - HERMES_PRE_SHUTDOWN_S - SHUTDOWN_MARGIN_S), threading.TIMEOUT_MAX)


def _launcher_name(path: str) -> str:
    if sys.platform == "win32":
        return ntpath.basename(path).lower()
    return path.lower()


def _launcher_allowed(path: str) -> bool:
    if sys.platform != "win32":
        return True
    name = _launcher_name(path)
    return ":" not in name and name.endswith((".js", ".exe"))


def launcher() -> list[str]:
    override = os.environ.get("HIPPO_BIN", "").strip()
    rec = _launcher_record()
    node = rec["node"] if rec and Path(rec["node"]).exists() else "node"
    if override:
        if not _launcher_allowed(override):
            raise ValueError("HIPPO_BIN must name hippo.js or a hippo .exe on Windows")
        return [node, override] if _launcher_name(override).endswith(".js") else [override]
    if rec and Path(rec["script"]).exists():
        return [node, rec["script"]]
    return ["hippo"]


def _runnable(argv: list[str]) -> bool:
    if Path(argv[-1]).is_file():
        return True
    found = shutil.which(argv[0]) if len(argv) == 1 else None
    return bool(found) and _launcher_allowed(found)


def _ignore(_: subprocess.Popen) -> None:
    return None


def run_hippo(verb: str, args: list[str], text: Optional[str] = None, stdin: Optional[str] = None,
              on_start: Callable[[subprocess.Popen], None] = _ignore) -> Optional[Result]:
    try:
        argv = [*launcher(), verb, *args, "--global"]
    except ValueError as exc:
        logger.warning("hippo %s refused: %s", verb, exc)
        return None
    if text is not None:
        argv += ["--", text]
    try:
        proc = Popen(
            argv, cwd=str(Path.home()),
            stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8", errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
    except OSError as exc:
        logger.warning("hippo %s failed: %s", verb, exc)
        return None
    on_start(proc)
    try:
        out, err = proc.communicate(stdin, timeout=TIMEOUTS[verb])
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        logger.warning("hippo %s timed out after %d s", verb, TIMEOUTS[verb])
        return None
    return Result(proc.returncode, out, err)


def _ok(verb: str, res: Optional[Result]) -> Optional[str]:
    if res is None:
        return None
    if res.code != 0:
        logger.warning("hippo %s exited %d: %s", verb, res.code, (res.err or res.out).strip()[:500])
        return None
    return res.out


def hook_context(out: Optional[str]) -> str:
    if not out or not out.strip():
        return ""
    try:
        data = json.loads(out)
    except ValueError:
        logger.warning("hippo context gave no JSON: %s", out.strip()[:200])
        return ""
    hook = data.get("hookSpecificOutput") if isinstance(data, dict) else None
    text = hook.get("additionalContext") if isinstance(hook, dict) else None
    return text if isinstance(text, str) else ""


def capture_tenant_ok() -> bool:
    return os.environ.get("HIPPO_TENANT", "").strip() in ("", "default")


def opt_in_platforms() -> frozenset[str]:
    try:
        from hermes_cli.config import load_config
        memory = load_config().get("memory", {})
    except Exception as exc:
        logger.warning("hippo: config.yaml was not read, so no platform is opted in: %s", exc)
        return frozenset()
    block = memory.get("hippo") if isinstance(memory, dict) else None
    platforms = block.get("platforms", []) if isinstance(block, dict) else []
    if not isinstance(platforms, list):
        logger.warning("hippo: memory.hippo.platforms must be a list, not %r", platforms)
        return frozenset()
    return frozenset(p.strip().lower() for p in platforms if isinstance(p, str) and p.strip())


@functools.cache
def _session_source() -> Optional[Callable[[Optional[str]], str]]:
    try:
        from agent.session_source import session_source_for
    except ImportError as exc:
        logger.warning("hippo is off: agent.session_source did not import: %s", exc)
        return None
    return session_source_for


@functools.cache
def _policy_helpers() -> Optional[tuple[Callable[[], Any], Callable[[Any], Optional[str]]]]:
    try:
        from gateway.session_policy import active_policy, created_surface
    except ImportError as exc:
        logger.warning("hippo is off: gateway.session_policy did not import: %s", exc)
        return None
    return active_policy, created_surface


def _resolve_source(platform: str) -> str:
    source_for = _session_source()
    policy_helpers = _policy_helpers()
    if source_for is None or policy_helpers is None:
        return ""
    active_policy, created_surface = policy_helpers
    policy = active_policy()
    policy_source = getattr(policy, "source", None) if policy is not None else None
    if isinstance(policy_source, str) and policy_source.strip():
        mapped = created_surface(policy_source.strip())
        if mapped is not None:
            return mapped
    return source_for(platform)


@functools.cache
def row_helpers() -> Optional[SimpleNamespace]:
    try:
        from agent.conversation_compression_scaffolding import has_scaffolding_flag, is_user_role_scaffolding
        from agent.message_metadata import PRE_LLM_BLOCK_WITHHELD_PROMPT, typed_ask_text
        from agent.prompt_builder import STEER_MARKER_CLOSE, STEER_MARKER_OPEN
        from gateway.message_timestamps import strip_leading_message_timestamps
        from session_rules.turns import (extract_user_instruction_from_skill_message, flatten_message_text,
                                         is_compaction_summary_message, sanitize_context, user_originated_turn_view)
    except ImportError as exc:
        logger.warning("hippo: capture is off: Hermes row helpers did not import: %s", exc)
        return None
    return SimpleNamespace(
        has_scaffolding_flag=has_scaffolding_flag, is_user_role_scaffolding=is_user_role_scaffolding,
        typed_ask_text=typed_ask_text, withheld=PRE_LLM_BLOCK_WITHHELD_PROMPT,
        steer_open=STEER_MARKER_OPEN, steer_close=STEER_MARKER_CLOSE,
        strip_timestamps=strip_leading_message_timestamps, skill_ask=extract_user_instruction_from_skill_message,
        flatten=flatten_message_text, is_summary=is_compaction_summary_message, sanitize=sanitize_context,
        live_view=user_originated_turn_view)


def _untimed(text: Any, h: SimpleNamespace) -> Any:
    return h.strip_timestamps(text)[0]


def steer_text(text: str, h: SimpleNamespace) -> str:
    body = text.strip()
    if body.startswith(h.steer_open) and body.endswith(h.steer_close):
        return body[len(h.steer_open):-len(h.steer_close)].strip()
    return text


def person_text(row: dict[str, Any], h: SimpleNamespace) -> Optional[str]:
    if row.get("role") != "user" or h.has_scaffolding_flag(row):
        return None
    if isinstance(row.get("content"), str):
        row = {**row, "content": _untimed(row["content"], h)}
    if h.is_user_role_scaffolding(row):
        return None
    view = h.live_view(row)
    if view is None:
        return None
    ask = h.typed_ask_text(row)
    if ask is None:
        ask = h.flatten(view.get("content"))
    ask = h.skill_ask(steer_text(_untimed(ask, h), h))
    if ask is None:
        return None
    return h.sanitize(_untimed(ask, h)).replace(h.withheld, "").strip() or None


def chat_lines(messages: list[Any]) -> list[dict[str, str]]:
    h = row_helpers()
    if h is None:
        return []
    out = []
    for row in (r for r in messages if isinstance(r, dict)):
        if row.get("role") == "assistant":
            shown = row.get("display_kind") or h.is_summary(row)
            text = "" if shown else h.sanitize(h.flatten(row.get("content"))).strip()
        else:
            text = person_text(row, h)
        if text:
            out.append({"role": row["role"], "content": text})
    return out


def safe_sid(sid: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", sid).strip("._")[:120] or "session"


def write_chat_lines(lines: list[dict[str, str]], path: Path) -> None:
    body = "".join(json.dumps(line, ensure_ascii=False) + "\n" for line in lines)
    path.write_text(body, encoding="utf-8", errors="replace", newline="\n")


def _error(message: str) -> str:
    return json.dumps({"error": message}, ensure_ascii=False)


def _log_capture_failure(future: Future) -> None:
    if future.cancelled():
        return
    exc = future.exception()
    if exc is not None:
        logger.error("hippo capture crashed: %r", exc, exc_info=exc)


def _text_arg(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    return value.strip() if isinstance(value, str) else ""


class HippoProvider(MemoryProvider):
    def __init__(self) -> None:
        self._session_id = ""
        self._platform = ""
        self._source = ""
        self._agent_context = "primary"
        self._opt_in_platforms: frozenset[str] = frozenset()
        self._initialized = False
        self._capture_on = False
        self._last_recall_ids: list[str] = []
        self._lock = threading.Lock()
        self._captures: Optional[ThreadPoolExecutor] = None
        self._capture_futures: list[Future] = []
        self._capture_proc: Optional[subprocess.Popen] = None
        self._closed = False
        self._stopping = False

    @property
    def name(self) -> str:
        return "hippo"

    def is_available(self) -> bool:
        try:
            return _runnable(launcher())
        except ValueError:
            return False

    def unavailable_reason(self) -> str:
        return "hippo CLI not found: run `hippo hook install hermes`, or set HIPPO_BIN to hippo's bin/hippo.js"

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._session_id = str(session_id or "")
        self._platform = str(kwargs.get("platform") or "")
        context = kwargs.get("agent_context")
        self._agent_context = context.strip() if isinstance(context, str) and context.strip() else "primary"
        self._opt_in_platforms = opt_in_platforms()
        self._source = _resolve_source(self._platform)
        self._initialized = True
        self._capture_on = self.allowed("capture") and row_helpers() is not None
        if self._capture_on and not capture_tenant_ok():
            logger.warning("hippo: capture is off: HIPPO_TENANT is %s, and capture --global writes the default "
                           "tenant", os.environ.get("HIPPO_TENANT", "").strip())
            self._capture_on = False

    def allowed(self, op: str) -> bool:
        opt_in = self._opt_in_platforms
        if self._platform not in LOCAL_PLATFORMS | opt_in:
            return False
        if self._source not in LOCAL_SOURCES | opt_in:
            return False
        row = CONTEXT_RULES.get(self._agent_context or "primary", CONTEXT_RULES["subagent"])
        return row[OPS.index(op)]

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not self.allowed("prefetch"):
            return ""
        payload = json.dumps({"session_id": session_id or self._session_id, "prompt": query}, ensure_ascii=False)
        return hook_context(_ok("context", run_hippo("context", list(CONTEXT_ARGS), stdin=payload)))

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        schemas = [copy.deepcopy(s) for s in TOOL_SCHEMAS]
        if not self._initialized:
            return schemas
        return [s for s in schemas if self.allowed(TOOL_OPS[s["name"]])]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs: Any) -> str:
        op = TOOL_OPS.get(tool_name)
        if op is None:
            return _error(f"hippo has no tool {tool_name}")
        if not self.allowed(op):
            return _error(f"hippo is off for {self._platform or 'none'}/{self._agent_context}")
        tools = {"recall": self._recall_tool, "remember": self._remember_tool, "outcome": self._outcome_tool}
        return tools[op](args if isinstance(args, dict) else {})

    def _recall_tool(self, args: dict[str, Any]) -> str:
        query = _text_arg(args, "query")
        if not query:
            return _error("query is required")
        self._last_recall_ids = []
        out = _ok("recall", run_hippo("recall", list(RECALL_ARGS), text=query))
        try:
            data = json.loads(out) if out is not None else None
        except ValueError:
            data = None
        if not isinstance(data, dict):
            return _error("hippo recall failed; the Hermes log says why")
        rows = [r for r in data.get("results") or [] if isinstance(r, dict) and isinstance(r.get("id"), str)]
        self._last_recall_ids = [r["id"] for r in rows]
        results = [{"id": r["id"], "content": r.get("content")} for r in rows]
        return json.dumps({"results": results, "total": len(results)}, ensure_ascii=False)

    def _remember_tool(self, args: dict[str, Any]) -> str:
        text = _text_arg(args, "text")
        if not text:
            return _error("text is required")
        out = _ok("remember", run_hippo("remember", list(REMEMBER_ARGS), text=text))
        if out is None:
            return _error("hippo remember failed; the Hermes log says why")
        first_line = (out.strip().splitlines() or [""])[0]
        return json.dumps({"result": first_line}, ensure_ascii=False)

    def _outcome_tool(self, args: dict[str, Any]) -> str:
        good = args.get("good")
        if not isinstance(good, bool):
            return _error("good must be true or false")
        ids = list(self._last_recall_ids)
        if not ids:
            return _error("no hippo_recall in this session to rate")
        flags = ["--good" if good else "--bad", *(part for one in ids for part in ("--id", one))]
        out = _ok("outcome", run_hippo("outcome", flags))
        if out is None:
            return _error("hippo outcome failed; the Hermes log says why")
        self._last_recall_ids = []
        return json.dumps({"result": out.strip()}, ensure_ascii=False)

    def on_session_end(self, messages: list[dict[str, Any]]) -> None:
        if not self._capture_on or not self.allowed("capture"):
            return
        lines = chat_lines(messages or [])
        if lines:
            self._submit_capture(lines, self._session_id)

    def on_session_switch(self, new_session_id: str, *, parent_session_id: str = "",
                          reset: bool = False, rewound: bool = False, **kwargs: Any) -> None:
        if rewound or not new_session_id:
            return
        self._session_id = new_session_id
        if kwargs.get("reason") != "compression":
            self._last_recall_ids = []

    def _submit_capture(self, lines: list[dict[str, str]], sid: str) -> None:
        with self._lock:
            if self._closed:
                logger.warning("hippo: capture of %s dropped: the provider is shut down", sid)
                return
            if self._captures is None:
                self._captures = ThreadPoolExecutor(max_workers=1, thread_name_prefix="hippo-capture")
                self._run_shutdown_at_exit()
            future = self._captures.submit(ctx_bound(self._capture_job), lines, sid)
            future.add_done_callback(_log_capture_failure)
            self._capture_futures = [f for f in self._capture_futures if not f.done()] + [future]

    def _run_shutdown_at_exit(self) -> None:
        try:
            threading._register_atexit(self.shutdown)
        except (AttributeError, RuntimeError) as exc:
            logger.warning("hippo: no exit hook for queued captures: %s", exc)

    def _capture_job(self, lines: list[dict[str, str]], sid: str) -> None:
        try:
            with tempfile.TemporaryDirectory(prefix="hippo-hermes-") as tmp:
                path = Path(tmp) / f"{safe_sid(sid)}.jsonl"
                write_chat_lines(lines, path)
                res = run_hippo("capture", ["--transcript", str(path)], on_start=self._keep_capture_proc)
        except OSError as exc:
            logger.warning("hippo capture of %s failed: %s", sid, exc)
            return
        finally:
            with self._lock:
                self._capture_proc = None
        _ok("capture", res)

    def _keep_capture_proc(self, proc: subprocess.Popen) -> None:
        with self._lock:
            if self._stopping:
                proc.kill()
            else:
                self._capture_proc = proc

    def shutdown(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            executor, futures = self._captures, tuple(self._capture_futures)
        if executor is None:
            return
        executor.shutdown(wait=False, cancel_futures=False)
        _, pending = wait(futures, timeout=capture_deadline_s())
        if not pending:
            return
        dropped = sum(future.cancel() for future in pending)
        with self._lock:
            self._stopping = True
            proc = self._capture_proc
        if proc is not None and proc.poll() is None:
            proc.kill()
        logger.warning("hippo: shutdown stopped %d running and dropped %d queued capture(s)",
                       len(pending) - dropped, dropped)


def register(ctx: Any) -> None:
    ctx.register_memory_provider(HippoProvider())
