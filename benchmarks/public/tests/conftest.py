"""Puts the public benchmark code on the path, as each script does for itself, plus shared call-log helpers."""
from __future__ import annotations

import json
import sys
from pathlib import Path

PUBLIC = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PUBLIC), str(PUBLIC / "qa"), str(PUBLIC / "mem0"), str(PUBLIC / "runner")]
RUNNER = Path.home() / "hippo-bench" / "memory-benchmarks"  # h2h imports Mem0's runner prompts from here

from qa.ledger import ANSWERER, hash16  # noqa: E402


def rec(tag: str, user: str, *, system: str = "", event: str = "ok", text: str = "yes", model: str = "claude-sonnet-5",
        effort: str = "medium", cli: str = ANSWERER.cli) -> dict:
    """One call-log record in claude_llm's shape."""
    return {"tag": tag, "sys": hash16(system), "user": hash16(user), "effort": effort, "cli": cli, "event": event,
            "models": [model], "text": text, "ts": 0.0}


def write_log(path: Path, records: list[dict]) -> Path:
    path.write_bytes(b"".join(json.dumps(r).encode() + b"\n" for r in records))
    return path
