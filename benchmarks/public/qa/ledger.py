"""The one reader of the append-only call logs that claude_llm.Claude and codex_judge.CodexJudge write.

Prereg Amendment 6 revision 1 items 5 to 7 and dated notes 1: an ask is a call that returned reply text; per prompt the
first 3 asks in log order are read and the first valid one counts; none valid in 3 scores wrong and is listed.
Judge and score stages take every answer and verdict from here, never from their own result files.
"""
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
ASK_EVENTS = ("ok", "json-miss", "tool-use")  # errors, timeouts and limit waits return no text, so they are no asks
SMOKE = Path(__file__).resolve().parents[1] / "smoke_excluded.json"


@dataclass(frozen=True)
class Manifest:
    model: str
    effort: str
    cli: str


ANSWERER = Manifest("claude-sonnet-5", "medium", "2.1.321 (Claude Code)")
JUDGE = Manifest("gpt-5.6-sol", "medium", "codex-cli 0.164.0")


def hash16(text: str) -> str:
    """The prompt hash claude_llm logs as `sys` and `user`."""
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def whole(text: str) -> str:
    return text


@dataclass(frozen=True)
class Item:
    """One prompt of the design: its log tag, both texts, the manifest its reply must meet and the reply's parse."""
    tag: str
    system: str
    user: str
    manifest: Manifest
    parse: Callable[[str], Any] = whole  # the reply's value, or None when it holds none

    @property
    def key(self) -> tuple[str, str]:
        return self.tag, hash16(self.user)


@dataclass(frozen=True)
class Choice:
    status: str  # "valid", "exhausted" (3 asks, none valid) or "open" (fewer asks, none valid)
    asks: int
    value: Any = None
    record: dict | None = None
    rejected: tuple[str, ...] = ()


def mismatch(rec: dict, item: Item) -> str | None:
    """Why a logged ask cannot be the item's reply, apart from its parse, or None."""
    m = item.manifest
    for name, got, want in (("event", rec.get("event"), "ok"), ("models", rec.get("models"), [m.model]),
                            ("effort", rec.get("effort"), m.effort), ("cli", rec.get("cli"), m.cli),
                            ("system hash", rec.get("sys"), hash16(item.system))):
        if got != want:
            return f"{name} {got!r}, not {want!r}"
    return None


def decide(asks: list[dict], item: Item) -> Choice:
    """The first valid reply among the item's first 3 asks in log order."""
    rejected: list[str] = []
    for rec in asks[:ASKS]:
        why = mismatch(rec, item)
        value = None if why else item.parse(rec.get("text") or "")
        if value is not None:
            return Choice("valid", len(rejected) + 1, value, rec, tuple(rejected))
        rejected.append(why or "reply does not parse")
    return Choice("exhausted" if len(rejected) >= ASKS else "open", len(rejected), rejected=tuple(rejected))


class Ledger:
    """A call log's asks by (tag, user hash) in log order, read once; asks made through settle join them."""

    def __init__(self, path: Path) -> None:
        self.asks: dict[tuple[str, str], list[dict]] = {}
        self.guard, self.locks = threading.Lock(), {}
        raw = path.read_bytes() if path.exists() else b""
        for line in raw[:raw.rfind(b"\n") + 1].split(b"\n"):  # LF alone; a record still being written is no ask yet
            if line.strip() and (rec := json.loads(line)).get("event") in ASK_EVENTS:
                self.asks.setdefault((rec["tag"], rec["user"]), []).append(rec)

    def choose(self, item: Item) -> Choice:
        return decide(self.asks.get(item.key, []), item)

    def settle(self, item: Item, llm) -> Choice:
        """Asks llm again until the item has a valid reply or its 3rd ask, counting every ask already made for it."""
        with self.guard:  # one settle per prompt at a time, so a prompt sent twice never gets more than 3 asks
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
    """Stops before any ask whose record the manifest would reject, so a new CLI cannot use up every item's asks."""
    if llm.cli != manifest.cli:
        sys.exit(f"the CLI reports {llm.cli!r}; the frozen manifest needs {manifest.cli!r}")


def unsettled(choices: dict, what: str) -> None:
    """Stops while any item still has asks left and no valid reply: never scored partial."""
    left = [k for k, c in choices.items() if c.status == "open"]
    if left:
        sys.exit(f"{what}: {len(left)} of {len(choices)} not settled, e.g. {left[0]}; run that stage again")


def exhausted_lines(choices: dict, what: str) -> list[str]:
    """Each exhausted item with why each of its asks was rejected; they score wrong (item 5)."""
    out = [f"  {k}: {'; '.join(c.rejected)}" for k, c in choices.items() if c.status == "exhausted"]
    return [f"{what} exhausted after {ASKS} asks, scored wrong: {len(out)}", *out]


def trail(choice: Choice) -> dict:
    """How a stage's own result file records an item: for people only, since no stage reads that file back."""
    return {"status": choice.status, "asks": choice.asks, "rejected": list(choice.rejected)}


def smoke_excluded(bench: str, universe: list[str]) -> set[str]:
    """The benchmark's smoke items, left out of every primary (dated notes 1). Every scored benchmark needs an entry,
    [] if it had no smoke run, and each listed item must be one of its items."""
    table = json.loads(SMOKE.read_text(encoding="utf-8"))
    if bench not in table:
        sys.exit(f"{SMOKE.name} has no entry for {bench}: add its smoke items, or [] if none ran, before scoring")
    ids = set(table[bench])
    if ids - set(universe):
        sys.exit(f"{SMOKE.name} lists {sorted(ids - set(universe))[:3]} for {bench}, which are not its items")
    return ids
