"""MEME's own code, imported from the pinned local clone (MIT), and its episodes from the pinned Hugging Face revision.

SeokwonJung-Jay/MEME-public cb8164d8: the unified answer prompt (code/agents/base.py), the Mem0 wrapper's context lines
(code/agents/mem0_memory.py Mem0Memory.retrieve, run here over hippo's hits) and the GPT-4o judge with its trivial-pass
rule (code/eval/judge.py LLMJudge, judge_episode), which calls the OpenAI client it is given. LedgerClient is that
client: each create call is a ledger item, asked through qa/openai_llm.py.
"""
from __future__ import annotations

import calendar
import datetime as dt
import functools
import hashlib
import importlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path[:0] = [str(Path(__file__).resolve().parents[1])]
from qa.ledger import Item, Ledger, Manifest  # noqa: E402
from qa.openai_llm import EFFORT, Settings  # noqa: E402
from qa.vendor_pin import check  # noqa: E402

CLONE = Path.home() / "hippo-bench" / "vendor" / "MEME"
COMMIT = "cb8164d8e5a5e07d974502e828262dfc9ec88d1b"
BLOBS = {  # git ls-tree at COMMIT
    "code/agents/__init__.py": "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    "code/agents/base.py": "e8011dcb4b6b8981a3c92a8e32e3482aa5792c7f",
    "code/agents/mem0_memory.py": "8e319657a497f10b47d5343e0c036f867bc10431",
    "code/eval/judge.py": "106e9ba9366863aa2ea0bf97c5ab79aeb4f803d3",
    "code/eval/run_agent.py": "1e2a511e737ca46c96ea48098da6b70d8d75e3cc",
    "code/scripts/run_main_experiment.sh": "83e381cf8943fe47732cf775cd31ab35933b91cc",
}
DATA = Path.home() / "hippo-bench" / "datasets" / "meme" / "meme_filler32k.json"
HF_REVISION = "e14c4e685772014deb96f91dc7eddfbeb21d90d8"  # meme-benchmark/MEME; the file's LFS oid is its SHA-256
DATA_SHA256 = "a88d28374a002b3e5b1683fb7201d06a1ce739d2ebf94c971c37bb65cf6ebdd3"
MINI = "gpt-4.1-mini-2025-04-14"  # run_main_experiment.sh ANSWER_MODEL gpt-4.1-mini; tab:manifest names the snapshot
FOUR_O = "gpt-4o-2024-08-06"  # judge.py --judge-model gpt-4o; tab:manifest and judge_audit_144.json name the snapshot
ANSWERER = Settings(MINI, temperature=0.0, max_tokens=500)  # base.py answer_question: one user message
JUDGE = Settings(FOUR_O, temperature=0.0, json_object=True)  # judge.py LLMJudge._call: one user message
A_MAN, J_MAN = Manifest(MINI, EFFORT, ANSWERER.cli), Manifest(FOUR_O, EFFORT, JUDGE.cli)
TOPK = 20  # Table 2's Mem0 row: Memory.search with no limit, "top-20 ... library default" (app:systems)
TASKS = ("ER", "Agg", "Tr", "Del", "Cas", "Abs")  # Table 2's column order
FILTERED = ("Cas", "Abs", "Del")  # trivial-pass filtering: credit needs the before answer right too


@functools.lru_cache(maxsize=1)
def code() -> SimpleNamespace:
    """The vendor modules, checked once; code/ goes first on the path, as run_agent.py puts it."""
    check(CLONE, COMMIT, BLOBS)
    root = CLONE / "code"
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    mods = {n: importlib.import_module(n) for n in ("agents.base", "agents.mem0_memory", "eval.judge")}
    for m in mods.values():
        if not Path(m.__file__).resolve().is_relative_to(root.resolve()):
            sys.exit(f"{m.__name__} resolves to {m.__file__}, not MEME's clone")
    return SimpleNamespace(base=mods["agents.base"], mem0=mods["agents.mem0_memory"], judge=mods["eval.judge"])


@functools.lru_cache(maxsize=1)
def episodes() -> list[dict]:
    raw = DATA.read_bytes()
    if hashlib.sha256(raw).hexdigest() != DATA_SHA256:
        sys.exit(f"{DATA} is not meme_filler32k.json at {HF_REVISION[:8]}: download it again")
    return json.loads(raw)


def epoch(stamp: str) -> int:
    """A session timestamp such as "2023/03/01 (Wed) 09:00", read as UTC."""
    return calendar.timegm(dt.datetime.strptime(stamp, "%Y/%m/%d (%a) %H:%M").timetuple())


def context(hits: list[dict]) -> str:
    """Mem0Memory.retrieve's text over hippo's ranked hits: "[score=0.00] <memory>" lines."""
    store = SimpleNamespace(memory=SimpleNamespace(search=lambda **_: {"results": hits}), _user_id="u", _top_k=None)
    return code().mem0.Mem0Memory.retrieve(store, "")


def prompt(context_text: str, question: str) -> str:
    return code().base.UNIFIED_ANSWER_PROMPT.format(context=context_text, question=question)


class NoReply(RuntimeError):
    """A judge call with no valid reply: LLMJudge._call retries, then raises, and the episode is not judged."""


def judge_parse(text: str):
    """A valid reply is what LLMJudge._call accepts and its checks can read: a JSON object, fenced or not."""
    try:
        data = json.loads(text)
    except ValueError:
        t = text.strip()
        try:
            if t.startswith("```"):
                t = t.split("\n", 1)[1]
                t = t[:-3] if t.endswith("```") else t
            data = json.loads(t)
        except (ValueError, IndexError):
            return None
    return data if isinstance(data, dict) else None


class LedgerClient:
    """The OpenAI client LLMJudge calls, one per episode. live: open items are asked (3 asks, first valid counts);
    else only the log is read and any open item is listed, so the score stage never grades on a partial log."""

    def __init__(self, ledger: Ledger, llm, tag: str) -> None:
        self.ledger, self.llm, self.tag = ledger, llm, tag
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        self.open: list[tuple[str, str]] = []

    def create(self, *, model: str, messages: list[dict], temperature: float, response_format: dict):
        if (model, [m["role"] for m in messages], temperature, response_format) != (
                "gpt-4o", ["user"], 0, {"type": "json_object"}):
            raise RuntimeError(f"unexpected judge call: {model} {[m['role'] for m in messages]} {temperature}")
        item = Item(self.tag, "", messages[0]["content"], J_MAN, parse=judge_parse)
        choice = self.ledger.settle(item, self.llm) if self.llm else self.ledger.choose(item)
        if choice.status == "open":
            self.open.append(item.key)
        if choice.status != "valid":
            raise NoReply(f"{item.tag}: no valid reply ({choice.status}, {choice.asks} asks)")
        u = choice.record.get("usage") or {}
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=choice.record["text"]))],
                               usage=SimpleNamespace(prompt_tokens=u.get("prompt_tokens") or 0,
                                                     completion_tokens=u.get("completion_tokens") or 0))
