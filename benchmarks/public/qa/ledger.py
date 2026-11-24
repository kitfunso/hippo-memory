from __future__ import annotations

import hashlib
import json
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "mem0"))
from claude_llm import ToolUse  # noqa: E402

ASKS = 3
ASK_EVENTS = ("ok", "json-miss", "tool-use")
SMOKE = Path(__file__).resolve().parents[1] / "smoke_excluded.json"


@dataclass(frozen=True)
class Manifest:
    model: str
    effort: str
    cli: str


ANSWERER = Manifest("claude-sonnet-5", "medium", "2.1.321 (Claude Code)")
JUDGE = Manifest("gpt-5.6-sol", "medium", "codex-cli 0.164.0")


def hash16(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def whole(text: str) -> str:
    return text


@dataclass(frozen=True)
class Item:
    tag: str
    system: str
    user: str
    manifest: Manifest
    parse: Callable[[str], Any] = whole

    @property
    def key(self) -> tuple[str, str]:
        return self.tag, hash16(self.user)


@dataclass(frozen=True)
class Choice:
    status: str
    asks: int
    value: Any = None
    record: dict | None = None
    rejected: tuple[str, ...] = ()


def mismatch(rec: dict, item: Item) -> str | None:
    m = item.manifest
    for name, got, want in (("event", rec.get("event"), "ok"), ("models", rec.get("models"), [m.model]),
                            ("effort", rec.get("effort"), m.effort), ("cli", rec.get("cli"), m.cli),
                            ("system hash", rec.get("sys"), hash16(item.system))):
        if got != want:
            return f"{name} {got!r}, not {want!r}"
    return None


def decide(asks: list[dict], item: Item) -> Choice:
    rejected: list[str] = []
    for rec in asks[:ASKS]:
        why = mismatch(rec, item)
        value = None if why else item.parse(rec.get("text") or "")
        if value is not None:
            return Choice("valid", len(rejected) + 1, value, rec, tuple(rejected))
        rejected.append(why or "reply does not parse")
    return Choice("exhausted" if len(rejected) >= ASKS else "open", len(rejected), rejected=tuple(rejected))


class Ledger:
    def __init__(self, path: Path) -> None:
        self.asks: dict[tuple[str, str], list[dict]] = {}
        self.guard, self.locks = threading.Lock(), {}
        raw = path.read_bytes() if path.exists() else b""
        for line in raw[:raw.rfind(b"\n") + 1].split(b"\n"):
            if line.strip() and (rec := json.loads(line)).get("event") in ASK_EVENTS:
                self.asks.setdefault((rec["tag"], rec["user"]), []).append(rec)

    def choose(self, item: Item) -> Choice:
        return decide(self.asks.get(item.key, []), item)

    def settle(self, item: Item, llm) -> Choice:
        with self.guard:
            lock = self.locks.setdefault(item.key, threading.Lock())
        with lock:
            asks = self.asks.setdefault(item.key, [])
            choice = decide(asks, item)
            while choice.status == "open":
                try:
                    asks.append(llm.ask(item.system, item.user, effort=item.manifest.effort, tag=item.tag))
                except ToolUse as e:
                    asks.append(e.rec)
                choice = decide(asks, item)
            return choice


def require(llm, manifest: Manifest) -> None:
    if llm.cli != manifest.cli:
        sys.exit(f"the CLI reports {llm.cli!r}; the frozen manifest needs {manifest.cli!r}")


def unsettled(choices: dict, what: str) -> None:
    left = [k for k, c in choices.items() if c.status == "open"]
    if left:
        sys.exit(f"{what}: {len(left)} of {len(choices)} not settled, e.g. {left[0]}; run that stage again")


def exhausted_lines(choices: dict, what: str) -> list[str]:
    out = [f"  {k}: {'; '.join(c.rejected)}" for k, c in choices.items() if c.status == "exhausted"]
    return [f"{what} exhausted after {ASKS} asks, scored wrong: {len(out)}", *out]


def trail(choice: Choice) -> dict:
    return {"status": choice.status, "asks": choice.asks, "rejected": list(choice.rejected)}


def smoke_excluded(bench: str, universe: list[str]) -> set[str]:
    table = json.loads(SMOKE.read_text(encoding="utf-8"))
    if bench not in table:
        sys.exit(f"{SMOKE.name} has no entry for {bench}: add its smoke items, or [] if none ran, before scoring")
    ids = set(table[bench])
    if ids - set(universe):
        sys.exit(f"{SMOKE.name} lists {sorted(ids - set(universe))[:3]} for {bench}, which are not its items")
    return ids
