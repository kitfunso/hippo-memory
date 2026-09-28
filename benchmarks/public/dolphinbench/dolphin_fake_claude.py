"""Stand-in for the Claude Code CLI in DolphinBench dry runs. It makes no model call: it takes the same flags,
runs the UserPromptSubmit hook from --settings, calls the memory MCP tool and, when the test exposes it,
place_order, then prints Claude-style stream-json and, unless --no-session-persistence, writes a session file with
the hook's context as Claude does. Exits 3 if the token handoff contract is broken. DOLPHIN_FAKE_FAIL=1 dies after
a turn, =idle before any turn, =limit on a usage limit that resets in 7 hours, =drop leaves the context out."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "hippo-bench" / "dolphinbench"))
from examples.mcp_connection import connect_apps  # noqa: E402

ORDER = {"restaurant": "Blue Bottle Coffee", "items": ["small latte"], "notes": "pickup"}
USAGE = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
SESSION_FILE: Path | None = None  # set in main unless --no-session-persistence


def save(line: dict) -> None:
    """One line of Claude's own session file, the record the adapter reads the injected context and effort from."""
    if SESSION_FILE is not None:
        with SESSION_FILE.open("a", encoding="utf-8") as out:
            out.write(json.dumps(line) + "\n")


def emit(event: dict) -> None:
    print(json.dumps(event), flush=True)
    if event["type"] == "assistant":
        save({**event, "isSidechain": False, "effort": os.environ.get("CLAUDE_CODE_EFFORT_LEVEL")})
    elif event["type"] == "user":
        save({**event, "isSidechain": False})


def run_hooks(settings: dict, prompt: str, session: str) -> list[str]:
    """Runs each UserPromptSubmit hook and returns the additionalContext each one printed."""
    payload = json.dumps({"session_id": session, "hook_event_name": "UserPromptSubmit",
                          "cwd": os.getcwd(), "prompt": prompt})
    contexts = []
    for group in settings.get("hooks", {}).get("UserPromptSubmit", []):
        for hook in group["hooks"]:
            done = subprocess.run(hook["command"], shell=True, input=payload, capture_output=True,
                                  text=True, timeout=hook.get("timeout", 60))
            if done.returncode != 0:
                raise SystemExit(f"UserPromptSubmit hook exited {done.returncode}: {done.stderr.strip()}")
            if done.stdout.strip():
                contexts.append(json.loads(done.stdout)["hookSpecificOutput"]["additionalContext"])
    return contexts


async def call(spec: dict, tool: str, arguments: dict) -> str | None:
    async with connect_apps({"env": {}, **spec}) as session:
        if tool not in [t.name for t in (await session.list_tools()).tools]:
            return None
        return (await session.call_tool(tool, arguments)).content[0].text


def step(session: str, model: str, message_id: str, name: str, arguments: dict, result: str) -> None:
    """One assistant message split over two events, as Claude streams it, then its tool result."""
    call_id = f"toolu_{uuid.uuid4().hex[:12]}"
    base = {"type": "assistant", "session_id": session, "parent_tool_use_id": None}
    blocks = [{"type": "text", "text": f"Calling {name}."},
              {"type": "tool_use", "id": call_id, "name": name, "input": arguments}]
    for block in blocks:
        emit({**base, "message": {"id": message_id, "role": "assistant", "model": model, "content": [block],
                                  "usage": USAGE}})
    emit({"type": "user", "session_id": session, "parent_tool_use_id": None,
          "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call_id,
                                                   "content": [{"type": "text", "text": result}]}]}})


def main() -> int:
    global SESSION_FILE
    started = time.monotonic()
    parser = argparse.ArgumentParser()
    for flag in ("--print", "--output-format", "--tools", "--session-id", "--permission-mode", "--mcp-config",
                 "--settings", "--allowedTools", "--model"):
        parser.add_argument(flag)
    parser.add_argument("--no-session-persistence", action="store_true")
    args, _ = parser.parse_known_args()
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    if not token or "DOLPHIN_CLAUDE_OAUTH_TOKEN" in os.environ or not os.environ.get("CLAUDE_CONFIG_DIR"):
        print("token handoff broken: expected CLAUDE_CODE_OAUTH_TOKEN and CLAUDE_CONFIG_DIR only", file=sys.stderr)
        return 3
    session = args.session_id or str(uuid.uuid4())
    fail = os.environ.get("DOLPHIN_FAKE_FAIL", "")
    if not args.no_session_persistence:
        # Claude's layout: projects/<working directory, each non-alphanumeric as "-">/<session>.jsonl
        project = re.sub(r"[^A-Za-z0-9]", "-", os.getcwd())
        SESSION_FILE = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / project / f"{session}.jsonl"
        SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
    contexts = run_hooks(json.loads(Path(args.settings).read_text()), args.print, session)
    save({"type": "user", "isSidechain": False, "message": {"role": "user", "content": args.print}})
    if contexts and fail != "drop":
        save({"type": "attachment", "isSidechain": False, "attachment": {
            "type": "hook_additional_context", "content": contexts, "hookName": "UserPromptSubmit",
            "toolUseID": f"hook-{uuid.uuid4()}", "hookEvent": "UserPromptSubmit"}})
    servers = json.loads(Path(args.mcp_config).read_text())["mcpServers"]
    emit({"type": "system", "subtype": "init", "session_id": session, "model": args.model,
          "tools": [*args.tools.split(","), "mcp__memory__search_memories"]})
    if fail == "idle":
        return 1
    if fail == "limit":
        # The shape claude_driver's own tests give 2.1.259, plus the synthetic notice the CLI prints.
        notice = "You've hit your session limit"
        emit({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": int(time.time()) + 7 * 3600}})
        emit({"type": "assistant", "session_id": session, "parent_tool_use_id": None,
              "message": {"id": "msg_fake_limit", "role": "assistant", "model": "<synthetic>", "usage": USAGE,
                          "content": [{"type": "text", "text": notice}]}})
        emit({"type": "result", "subtype": "success", "is_error": True, "api_error_status": 429, "result": notice,
              "session_id": session})
        return 0
    query = re.sub(r"^\[[^\]]*\]\s*", "", args.print)
    found = asyncio.run(call(servers["memory"], "search_memories", {"query": query}))
    step(session, args.model, "msg_fake_1", "mcp__memory__search_memories", {"query": query}, found or "")
    if fail == "1":
        # Dies mid-call with no result event, as a timeout or API error would, to drive the retry and close path.
        emit({"type": "assistant", "session_id": session, "parent_tool_use_id": None,
              "message": {"id": "msg_fake_2", "role": "assistant", "model": args.model, "usage": USAGE, "content": [
                  {"type": "tool_use", "id": f"toolu_{uuid.uuid4().hex[:12]}", "name": "Read", "input": {}}]}})
        return 1
    placed = asyncio.run(call(servers["dolphinbench_apps"], "place_order", ORDER))
    if placed is not None:
        step(session, args.model, "msg_fake_2", "mcp__dolphinbench_apps__place_order", ORDER, placed)
    # The final text echoes the token on purpose: the adapter must redact it before anything is saved.
    final = f"Dry run finished. Token seen by the agent: {token}"
    emit({"type": "assistant", "session_id": session, "parent_tool_use_id": None,
          "message": {"id": "msg_fake_3", "role": "assistant", "model": args.model,
                      "content": [{"type": "text", "text": final}], "usage": USAGE}})
    # A helper model beside the main one, as Claude Code's own small calls appear, so check reports it apart.
    usage = {args.model: {"inputTokens": 120, "outputTokens": 30}, "fake-helper": {"inputTokens": 12, "outputTokens": 3}}
    emit({"type": "result", "subtype": "success", "is_error": False, "result": final, "session_id": session,
          "total_cost_usd": 0.0, "duration_ms": round((time.monotonic() - started) * 1000), "num_turns": 3,
          "usage": USAGE, "modelUsage": usage})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
