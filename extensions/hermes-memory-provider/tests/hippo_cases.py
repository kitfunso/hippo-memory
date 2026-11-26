from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Callable

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PLUGIN_ROOT.parents[1]
REAL_HIPPO_BIN = os.environ.get("HIPPO_BIN") or str(REPO_ROOT / "bin" / "hippo.js")
UNICODE = "café ☕ 日本"

FAKE_JS = r"""
const fs = require('fs');
const tty = require('tty');
const [verb, ...args] = process.argv.slice(2);
const key = 'FAKE_HIPPO_' + String(verb).toUpperCase();
let stdinKind = 'pipe';
try {
  if (fs.fstatSync(0).isCharacterDevice() && !tty.isatty(0)) stdinKind = 'devnull';
} catch (e) {
  stdinKind = 'error:' + e.code;
}
const stdin = stdinKind === 'pipe' ? fs.readFileSync(0, 'utf8') : '';
const at = args.indexOf('--transcript');
const transcript = at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : null;
const record = {
  verb, args, cwd: process.cwd(), stdinKind, stdin, transcript, pid: process.pid,
  tenant: process.env.HIPPO_TENANT ?? null, hippoHome: process.env.HIPPO_HOME ?? null,
};
fs.appendFileSync(process.env.FAKE_HIPPO_LOG, JSON.stringify(record) + '\n');
const sleep = Number(process.env[key + '_SLEEP'] || 0);
if (sleep > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleep * 1000);
process.stdout.write(process.env[key + '_OUT'] || '');
process.exitCode = Number(process.env[key + '_CODE'] || 0);
"""


class FakeHippo:
    def __init__(self, script: Path, log: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.script = script
        self.log = log
        self._monkeypatch = monkeypatch

    def answer(self, verb: str, out: str = "", sleep: float = 0, code: int = 0) -> None:
        key = f"FAKE_HIPPO_{verb.upper()}"
        self._monkeypatch.setenv(f"{key}_OUT", out)
        self._monkeypatch.setenv(f"{key}_SLEEP", str(sleep))
        self._monkeypatch.setenv(f"{key}_CODE", str(code))

    def calls(self, verb: str | None = None) -> list[dict[str, Any]]:
        lines = self.log.read_text(encoding="utf-8").splitlines()
        records = [json.loads(line) for line in lines if line.strip()]
        return [r for r in records if verb is None or r["verb"] == verb]


def hook_reply(text: str) -> str:
    return json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": text}},
                      ensure_ascii=False)


def recall_reply(*ids: str) -> str:
    return json.dumps({"results": [{"id": one, "content": f"memory {one}"} for one in ids], "total": len(ids)})


def session(ask: str, reply: str = "Done.") -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": "You are Hermes."},
        {"role": "user", "content": ask},
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "terminal", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "tool output that is not a turn"},
        {"role": "assistant", "content": reply},
    ]


def capture_names(fake: FakeHippo) -> list[str]:
    return [Path(call["args"][call["args"].index("--transcript") + 1]).name for call in fake.calls("capture")]


def transcript_lines(call: dict[str, Any]) -> list[dict[str, str]]:
    return [json.loads(line) for line in call["transcript"].splitlines() if line.strip()]


def same_path(a: str | Path, b: str | Path) -> bool:
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def wait_for(check: Callable[[], bool], timeout: float = 15) -> None:
    deadline = time.monotonic() + timeout
    while not check():
        if time.monotonic() > deadline:
            raise AssertionError("the condition did not hold in time")
        time.sleep(0.05)


def write_config(hermes_home: Path, body: str) -> None:
    (hermes_home / "config.yaml").write_text(body, encoding="utf-8")
