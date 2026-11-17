#!/usr/bin/python3
"""A stand-in for Claude Code 2.1.259 on the official plugin path, so the runner proves its plumbing without a model.

It takes the flags the official driver passes, runs the plugin's command hooks with Claude Code's stdin payloads,
starts the plugin's and --mcp-config's MCP servers, makes real tool calls, keeps a transcript where Claude Code keeps
one, and prints a stream-json trace. The init event carries a sandbox probe: uid, visible host paths, env names.
setup installs it as /opt/dolphin-official/fake/bin/claude; stdlib only.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/opt/dolphin-official/bin")
from dolphin_sandbox import McpClient, plugin_servers, server_command

VERSION = "2.1.259"
PROBE = re.compile(r"hippo_recall\b.*? query '([^']+)'")
USAGE = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}


def options(argv: list[str]) -> dict:
    found: dict = {"plugin_dirs": []}
    flags = {"--print": "message", "--session-id": "session", "--resume": "session", "--tools": "tools",
             "--mcp-config": "mcp_config", "--settings": "settings", "--model": "model",
             "--allowedTools": "allowed", "--output-format": "format", "--permission-mode": "permission"}
    items = iter(argv)
    for item in items:
        if item == "--plugin-dir":
            found["plugin_dirs"].append(next(items))
        elif item in flags:
            found[flags[item]] = next(items)
    return found


def probe() -> dict:
    try:
        open("/etc/.dolphin-probe", "w").close()
        etc_writable = True
    except OSError:
        etc_writable = False
    status = Path("/proc/self/status").read_text()
    return {"uid": os.getuid(), "gid": os.getgid(), "groups": os.getgroups(),
            "cap_eff": re.search(r"CapEff:\s*(\w+)", status).group(1),
            "mnt_visible": os.path.exists("/mnt/c"), "host_home_visible": os.path.exists("/home/skf_s"),
            "etc_writable": etc_writable, "srv": sorted(str(p) for p in Path("/srv").glob("*/*/*/*")),
            "env_keys": sorted(os.environ), "token_set": bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"))}


class Session:
    def __init__(self, opts: dict) -> None:
        self.opts, self.cwd = opts, os.getcwd()
        self.id = opts.get("session") or str(uuid.uuid4())
        config = Path(os.environ["CLAUDE_CONFIG_DIR"])
        self.transcript = config / "projects" / re.sub(r"[^A-Za-z0-9]", "-", self.cwd) / f"{self.id}.jsonl"
        self.transcript.parent.mkdir(parents=True, exist_ok=True)
        self.settings = json.loads(Path(opts["settings"]).read_text()) if opts.get("settings") else {}
        self.servers: dict[str, McpClient] = {}
        self.parent: str | None = None
        self.calls = 0

    def log(self, entry: dict) -> None:
        line = {"parentUuid": self.parent, "uuid": str(uuid.uuid4()), "sessionId": self.id, "cwd": self.cwd,
                "version": VERSION, "timestamp": datetime.now(timezone.utc).isoformat(), **entry}
        self.parent = line["uuid"]
        with self.transcript.open("a") as stream:
            stream.write(json.dumps(line) + "\n")

    def emit(self, event: dict) -> None:
        print(json.dumps({"session_id": self.id, **event}), flush=True)

    def hooks(self, event: str, matcher: str, extra: dict) -> list[str]:
        """Runs every command hook for one event as Claude Code does, and logs each as a transcript attachment."""
        stdin = json.dumps({"session_id": self.id, "transcript_path": str(self.transcript), "cwd": self.cwd,
                            "hook_event_name": event, **extra})
        contexts = []
        for plugin in self.opts["plugin_dirs"]:
            path = Path(plugin) / "hooks" / "hooks.json"
            groups = json.loads(path.read_text())["hooks"].get(event, []) if path.is_file() else []
            for group in groups:
                if not re.fullmatch(group.get("matcher") or ".*", matcher):
                    continue
                for hook in group["hooks"]:
                    contexts += self.hook(event, matcher, hook, stdin, plugin)
        return contexts

    def hook(self, event: str, matcher: str, hook: dict, stdin: str, plugin: str) -> list[str]:
        env = {**os.environ, "CLAUDE_PLUGIN_ROOT": plugin, "CLAUDE_PROJECT_DIR": self.cwd}
        name = f"{event}:{matcher}"
        started = time.monotonic()
        try:
            done = subprocess.run(["/bin/sh", "-c", hook["command"]], input=stdin, capture_output=True, text=True,
                                  env=env, cwd=self.cwd, timeout=hook.get("timeout", 60), check=False)
        except subprocess.TimeoutExpired:
            self.log({"type": "attachment", "attachment": {"type": "hook_cancelled", "hookName": name,
                      "hookEvent": event, "timedOut": True, "timeoutMs": hook.get("timeout", 60) * 1000}})
            return []
        took = round((time.monotonic() - started) * 1000)
        self.log({"type": "attachment", "attachment": {
            "type": "hook_success" if done.returncode == 0 else "hook_non_blocking_error", "hookName": name,
            "hookEvent": event, "exitCode": done.returncode, "durationMs": took, "command": hook["command"],
            "stdout": done.stdout[-2000:], "stderr": done.stderr[-2000:]}})
        try:
            context = json.loads(done.stdout)["hookSpecificOutput"]["additionalContext"]
        except (ValueError, KeyError, TypeError):
            return [done.stdout] if event == "UserPromptSubmit" and done.stdout.strip() else []
        self.log({"type": "attachment", "attachment": {"type": "hook_additional_context", "content": [context]}})
        return [context]

    def connect(self) -> list[dict]:
        specs = {}
        for plugin in self.opts["plugin_dirs"]:
            name = json.loads((Path(plugin) / ".claude-plugin" / "plugin.json").read_text())["name"]
            specs.update({f"plugin:{name}:{server}": spec for server, spec in plugin_servers(Path(plugin)).items()})
        if self.opts.get("mcp_config"):
            specs.update(json.loads(Path(self.opts["mcp_config"]).read_text())["mcpServers"])
        states = []
        for name, spec in specs.items():
            try:
                command, env = server_command(spec)
                self.servers[name] = McpClient(command, env, self.cwd, timeout=60)
                states.append({"name": name, "status": "connected"})
            except (OSError, RuntimeError) as error:
                states.append({"name": name, "status": "failed", "error": str(error)[:300]})
        return states

    def tool(self, name: str, arguments: dict, run) -> str:
        """One tool_use and its tool_result, in the trace and the transcript."""
        self.calls += 1
        call_id = f"toolu_fake_{self.calls:03d}"
        use = {"type": "assistant", "message": {"role": "assistant", "model": self.opts.get("model"),
               "content": [{"type": "tool_use", "id": call_id, "name": name, "input": arguments}]}}
        self.emit(use)
        self.log(use)
        try:
            text, error = run(), False
        except Exception as failure:  # noqa: BLE001 - a fake tool failure is data for the trace, as a real one would be
            text, error = f"{type(failure).__name__}: {failure}", True
        back = {"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": call_id, "content": text[:4000], "is_error": error}]}}
        self.emit(back)
        self.log(back)
        return text

    def mcp(self, server_suffix: str, tool: str, arguments: dict) -> str:
        server = next((name for name in self.servers if name.endswith(server_suffix)), None)
        if server is None:
            raise RuntimeError(f"no MCP server ends with {server_suffix}")
        prefix = server.replace(":", "_")
        return self.tool(f"mcp__{prefix}__{tool}", arguments, lambda: self.servers[server].call(tool, arguments))

    def close(self) -> None:
        for client in self.servers.values():
            client.close()


def act(session: Session, message: str, evaluation: bool) -> str:
    """Ingestion: a native-memory note and one recall. Evaluation: a recall, the app tool list, and on half of
    the tests a Bash look into ~/.hippo, so the runner's store-read count has something to find."""
    text = message.split("] ", 1)[-1]
    if match := PROBE.search(text):
        return session.mcp(":hippo-memory", "hippo_recall", {"query": match.group(1)})
    words = " ".join(re.findall(r"[A-Za-z]{5,}", text)[:6]) or "today"
    recalled = session.mcp(":hippo-memory", "hippo_recall", {"query": words})
    if not evaluation:
        folder = Path(session.settings["autoMemoryDirectory"])
        note = folder / "fake-agent-notes.md"
        line = f"- {text[:160]}\n"
        session.tool("Write", {"file_path": str(note), "content": line},
                     lambda: (folder.mkdir(parents=True, exist_ok=True), note.open("a").write(line), "ok")[2])
        return f"Noted. ({len(recalled)} characters recalled)"
    apps = session.servers.get("dolphinbench_apps")
    tools = session.tool("ListMcpResourcesTool", {"server": "dolphinbench_apps"},
                         lambda: json.dumps(apps.tools() if apps else []))
    if int(hashlib.sha256(text.encode()).hexdigest(), 16) % 2 == 0:
        session.tool("Bash", {"command": "ls -la ~/.hippo"}, lambda: subprocess.run(
            ["ls", "-la", os.path.expanduser("~/.hippo")], capture_output=True, text=True, check=False).stdout)
    return f"Fake answer: no action taken. {len(json.loads(tools))} app tools; recall gave {len(recalled)} chars."


def main() -> int:
    argv = sys.argv[1:]
    if "--version" in argv:
        print(f"{VERSION} (Claude Code)")
        return 0
    opts = options(argv)
    session = Session(opts)
    started = time.monotonic()
    tools = opts.get("tools", "default").split(",")
    evaluation = tools == ["default"]
    servers = session.connect()
    mcp_tools = [f"mcp__{name.replace(':', '_')}__{tool}" for name, client in session.servers.items()
                 for tool in client.tools()]
    session.emit({"type": "system", "subtype": "init", "cwd": session.cwd, "model": opts.get("model"),
                  "tools": (["Bash", "Read", "Write", "Edit", "Glob", "Grep"] if evaluation else tools) + mcp_tools,
                  "mcp_servers": servers, "claude_code_version": VERSION, "permissionMode": opts.get("permission"),
                  "fake_agent": True, "sandbox_probe": probe()})
    session.hooks("SessionStart", "startup", {"source": "startup"})
    message = opts["message"]
    session.hooks("UserPromptSubmit", "", {"prompt": message})
    session.log({"type": "user", "message": {"role": "user", "content": message}})
    try:
        answer = act(session, message, evaluation)
    finally:
        session.close()
    reply = {"type": "assistant", "message": {"role": "assistant", "model": opts.get("model"),
             "content": [{"type": "text", "text": answer}], "usage": USAGE}}
    session.emit(reply)
    session.log(reply)
    session.emit({"type": "result", "subtype": "success", "is_error": False, "result": answer, "usage": USAGE,
                  "total_cost_usd": 0, "duration_ms": round((time.monotonic() - started) * 1000),
                  "modelUsage": {opts.get("model") or "fake": {"inputTokens": 0, "outputTokens": 0}}})
    session.hooks("SessionEnd", "other", {"reason": "other"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
