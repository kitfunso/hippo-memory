"""Bubblewrap sandbox for the official DolphinBench Claude runs, stdlib only. setup installs it root-owned at SELF.

Host side it builds the bwrap command. `turn -- CMD` is the ingestion claude_command: the driver has already dropped
to the persona uid, and the sandbox binds only that persona's home. Inside, `init -- CMD` runs the agent and then
waits for every process it left (hippo's detached session-end worker), because a pid namespace dies with its first
process. `mcp` runs one MCP tool call for the smoke probe and the fake agent; `repeat` times a hook command.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

BASE = Path("/opt/dolphin-official")
SELF = BASE / "bin" / "dolphin_sandbox.py"
CONFIG = BASE / "sandbox.json"  # {"ro": [read-only dirs under /opt], "path": PATH inside}
RESOLV = BASE / "etc" / "resolv.conf"  # WSL's /etc/resolv.conf points into /mnt, which no sandbox sees
HOMES = Path("/srv/dolphin-official")
DRAIN_LIMIT = 900
DRAIN_TAG = "DOLPHIN_DRAIN "
ROOT_CAPS = ("CAP_CHOWN", "CAP_SETUID", "CAP_SETGID", "CAP_DAC_OVERRIDE", "CAP_FOWNER")


def system_binds() -> list[str]:
    """The system folders read-only, and an /etc rebuilt from the host's entries with a copied resolv.conf."""
    args = ["--ro-bind", "/usr", "/usr"]
    for name in ("bin", "sbin", "lib", "lib64", "lib32"):
        path = Path("/") / name
        if path.is_symlink():
            args += ["--symlink", os.readlink(path), str(path)]
        elif path.is_dir():
            args += ["--ro-bind", str(path), str(path)]
    args += ["--tmpfs", "/etc"]
    for entry in sorted(os.listdir("/etc")):
        path = f"/etc/{entry}"
        if entry == "resolv.conf":
            continue
        if os.path.islink(path):
            if not os.readlink(path).startswith("/mnt/"):
                args += ["--symlink", os.readlink(path), path]
        else:
            args += ["--ro-bind", path, path]
    return [*args, "--ro-bind", str(RESOLV), "/etc/resolv.conf", "--remount-ro", "/etc"]


def mount_parents(targets: list[str]) -> list[str]:
    """Root bwrap makes a mount point's missing parents 0700, which locks the agent's uid out, so make them 0755."""
    parents: list[str] = []
    for target in targets:
        for parent in reversed(Path(target).parents[:-1]):
            if str(parent) not in parents:
                parents.append(str(parent))
    return [flag for parent in parents for flag in ("--perms", "0755", "--dir", parent)]


def bwrap(binds: list[str], cwd: str, *, root: bool = False) -> list[str]:
    """The bwrap prefix: own pid namespace, dies with its parent, no host /mnt or /home, only `binds` writable."""
    config = json.loads(CONFIG.read_text())
    args = ["/usr/bin/bwrap", "--unshare-pid", "--die-with-parent", "--new-session"]
    if root:
        args += ["--cap-drop", "ALL"] + [flag for cap in ROOT_CAPS for flag in ("--cap-add", cap)]
    args += system_binds()
    targets = [*config["ro"], *(binds[i + 2] for i, flag in enumerate(binds) if flag in ("--bind", "--ro-bind"))]
    args += mount_parents(targets)
    for path in config["ro"]:
        args += ["--ro-bind", path, path]
    return [*args, "--tmpfs", "/tmp", "--dev", "/dev", "--proc", "/proc", *binds, "--chdir", cwd]


def persona_home(home: str) -> str:
    """A home the sandbox may bind: a real folder under HOMES, never a link out of it."""
    resolved = Path(home).resolve()
    if HOMES not in resolved.parents or not resolved.is_dir():
        raise SystemExit(f"refusing to sandbox a home outside {HOMES}: {home}")
    return str(resolved)


def turn(command: list[str]) -> None:
    home = persona_home(os.environ["HOME"])
    cwd = os.getcwd()
    if Path(home) not in Path(cwd).resolve().parents and Path(cwd).resolve() != Path(home):
        raise SystemExit(f"the working folder {cwd} is outside the sandboxed home {home}")
    args = bwrap(["--bind", home, home], cwd)
    os.execv(args[0], [*args, "/usr/bin/python3", str(SELF), "init", "--", *command])


def others() -> list[int]:
    me = os.getpid()
    return [int(p) for p in os.listdir("/proc") if p.isdigit() and int(p) not in (1, me)]


def cmdline(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")[:200]
    except OSError:
        return "?"


def init(command: list[str]) -> int:
    """Runs the agent, then waits for the rest of the pid namespace; one stderr line reports both times."""
    started = time.monotonic()
    code = subprocess.call(command)
    ended = time.monotonic()
    left = others()
    while left and time.monotonic() - ended < DRAIN_LIMIT:
        time.sleep(0.2)
        left = others()
    report = {"agent_seconds": round(ended - started, 3), "drain_seconds": round(time.monotonic() - ended, 3),
              "left": [cmdline(pid) for pid in left]}
    print(DRAIN_TAG + json.dumps(report), file=sys.stderr, flush=True)
    return code


def drain_report(stderr: str) -> dict | None:
    lines = [line for line in stderr.splitlines() if line.startswith(DRAIN_TAG)]
    return json.loads(lines[-1][len(DRAIN_TAG):]) if lines else None


class McpClient:
    """A minimal MCP stdio client: newline-delimited JSON-RPC, one request at a time."""

    def __init__(self, command: list[str], env: dict[str, str], cwd: str, timeout: float = 120) -> None:
        self.proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     env=env, cwd=cwd, text=True)
        self.timeout, self.next = timeout, 0
        self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                    "clientInfo": {"name": "dolphin-probe", "version": "1"}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def send(self, message: dict) -> None:
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def request(self, method: str, params: dict) -> dict:
        self.next += 1
        self.send({"jsonrpc": "2.0", "id": self.next, "method": method, "params": params})
        box: list[str] = []
        while True:
            reader = threading.Thread(target=lambda: box.append(self.proc.stdout.readline()), daemon=True)
            reader.start()
            reader.join(self.timeout)
            line = box.pop() if box else None
            if not line:
                raise RuntimeError(f"MCP server gave no reply to {method}")
            message = json.loads(line)
            if message.get("id") == self.next:
                if "error" in message:
                    raise RuntimeError(f"MCP {method} failed: {message['error']}")
                return message["result"]

    def tools(self) -> list[str]:
        return [tool["name"] for tool in self.request("tools/list", {})["tools"]]

    def call(self, tool: str, arguments: dict) -> str:
        result = self.request("tools/call", {"name": tool, "arguments": arguments})
        return "\n".join(block.get("text", "") for block in result.get("content", []))

    def close(self) -> None:
        self.proc.stdin.close()
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def plugin_servers(plugin: Path) -> dict[str, dict]:
    """The plugin's .mcp.json servers with ${CLAUDE_PLUGIN_ROOT} filled in, as Claude Code starts them."""
    path = plugin / ".mcp.json"
    if not path.is_file():
        return {}
    text = path.read_text().replace("${CLAUDE_PLUGIN_ROOT}", str(plugin))
    value = json.loads(text)
    return value.get("mcpServers", value)


def server_command(spec: dict) -> tuple[list[str], dict[str, str]]:
    env = {**os.environ, **{key: str(value) for key, value in (spec.get("env") or {}).items()}}
    return [spec["command"], *spec.get("args", [])], env


def mcp(plugin: str, server: str, tool: str, arguments: str) -> int:
    """One tool call on one plugin MCP server, started from the working folder; prints JSON."""
    command, env = server_command(plugin_servers(Path(plugin))[server])
    client = McpClient(command, env, os.getcwd())
    try:
        print(json.dumps({"tools": client.tools(), "result": client.call(tool, json.loads(arguments))}))
    finally:
        client.close()
    return 0


def repeat(count: int, command: list[str]) -> int:
    """Times `count` runs of one command, for the smoke's hook latency probe; prints JSON."""
    seconds = []
    for _ in range(count):
        started = time.monotonic()
        subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       check=False)
        seconds.append(round(time.monotonic() - started, 3))
    print(json.dumps({"seconds": seconds}))
    return 0


def main() -> int:
    mode, rest = sys.argv[1], sys.argv[2:]
    if mode in ("turn", "init"):
        command = rest[rest.index("--") + 1:]
        if mode == "turn":
            turn(command)
        return init(command)
    if mode == "mcp":
        return mcp(*rest)
    if mode == "repeat":
        return repeat(int(rest[0]), rest[rest.index("--") + 1:])
    raise SystemExit(f"unknown mode {mode}; use turn, init, mcp or repeat")


if __name__ == "__main__":
    raise SystemExit(main())
