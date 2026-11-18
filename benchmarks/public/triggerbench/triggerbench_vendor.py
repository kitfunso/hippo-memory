"""TriggerBench's own code and Base data, imported from the pinned local clone (code MIT, data CC BY 4.0).

KristenZHANG/TriggerBench-Official 9e2185c3, benchmark/prospective_memory: the turn format and the GPT-4o judge loop of
source/mem0_eval.py (_format_turn, _run_judge_batch), the answer system prompts (source/longcontext_blended_close.py),
the judge (pm_judge.py PMJudge) and the slot match (pm_scorer.py). The vendor's chat client (benchmark/utils/client.py,
Azure) is never imported: a stub stands in for it at import, and LedgerJudge is the client PMJudge calls.
"""
from __future__ import annotations

import calendar
import datetime as dt
import functools
import importlib
import json
import sys
import threading
import types
from pathlib import Path
from types import SimpleNamespace

sys.path[:0] = [str(Path(__file__).resolve().parents[1])]
from qa.ledger import Item, Ledger, Manifest, hash16, require  # noqa: E402
from qa.openai_llm import EFFORT, OpenAIChat, Settings  # noqa: E402
from qa.vendor_pin import check  # noqa: E402

CLONE = Path.home() / "hippo-bench" / "vendor" / "TriggerBench"
COMMIT = "9e2185c3d071f73c195196ba1859631898017c8d"
PM = "benchmark/prospective_memory"
DATA = f"{PM}/data/base_context"
BLOBS = {  # git ls-tree at COMMIT
    f"{PM}/pm_judge.py": "3e06ccaeaa36359a6c610e8334f999194557b843",
    f"{PM}/pm_scorer.py": "79664cbf7c0091896f23cca793af048e676fc430",
    f"{PM}/source/longcontext_blended_close.py": "92c4c54adb4c7f58c234d8abacc3974b450b1175",
    f"{PM}/source/mem0_eval.py": "7f3754c605c3b304710bb5e4891ca429d863ca6c",
    f"{PM}/source/run_mem0.sh": "c42c6c60ce5d04345bd4a53ecb48f2afd8488ef4",
    f"{DATA}/negative_clean/logical_adherence/logical_adherence_base.jsonl": "37e021dd6ed622a859e991e813da6dd7a368f867",
    f"{DATA}/negative_clean/safe_coding/safe_coding_base.jsonl": "80d8c41f2ba3e4739a36e675e75d2f00d30c3407",
    f"{DATA}/negative_clean/state_tracking/state_tracking_base.jsonl": "2182d88cd8fedff33ea640d72bb46982793dc065",
    f"{DATA}/positive_clean/attention_recovery/attention_recovery_base.jsonl": "1c4d15bae9cbed1c18ced414f24615414a55dabe",
    f"{DATA}/positive_clean/logical_adherence/logical_adherence_base.jsonl": "18f7caf25f42c9bc3dd6edf4b3644777e161ee71",
    f"{DATA}/positive_clean/safe_coding/safe_coding_base.jsonl": "83a0b44096d8903e90a24f8923a1800c967ee51f",
    f"{DATA}/positive_clean/state_tracking/state_tracking_base.jsonl": "88c7c8a85532958835a03e1426292c1cdb585f0f",
    f"{DATA}/positive_clean/temporal_grounding/temporal_grounding_base.jsonl": "e72d72fa4372726d1e947eadfdfe206dbd00ddee",
    f"{DATA}/positive_overloaded/attention_recovery/attention_recovery_base.jsonl":
        "5af06c60ae1b4f4883397298f554953389b35a7c",
    f"{DATA}/positive_overloaded/logical_adherence/logical_adherence_base.jsonl":
        "7facf0b43df4e80af44085ec684090ebd6ae8da0",
    f"{DATA}/positive_overloaded/safe_coding/safe_coding_base.jsonl": "cb8cc79c7dbd359d67622a8c2448a2c3a74c03c8",
    f"{DATA}/positive_overloaded/state_tracking/state_tracking_base.jsonl": "3bc9b392cb0cc3eca6ed0ac98429074060fee8f1",
    f"{DATA}/positive_overloaded/temporal_grounding/temporal_grounding_base.jsonl":
        "c8fbf0d71da2634b266c0791b954323d0cd7e804",
}
GEN = "gpt-4.1"  # run_mem0.sh AZURE_OPENAI_DEPLOYMENTS default; the API reports its one snapshot:
GEN_SNAPSHOT = "gpt-4.1-2025-04-14"
FOUR_O = "gpt-4o-2024-08-06"  # mem0_eval JUDGE_DEPLOYMENT "gpt-4o", an Azure deployment whose version no source states
ANSWERER = Settings(GEN, temperature=0.6, max_tokens=1024)  # run_mem0.sh TEMPERATURE=0.6; _run_one_mem0 max_tokens
A_MAN = Manifest(GEN_SNAPSHOT, EFFORT, ANSWERER.cli)
TOPK = 6  # run_mem0.sh TOP_K=6; appendix-setup.tex "top-k=6"
JUDGE_MAX_TOKENS = 256  # PMJudge.judge; its temperature is PMJudge's default 0.0
VARIANTS = {"positive_clean": "pc", "positive_overloaded": "po", "negative_clean": "nc"}
CATEGORIES = ("state_tracking", "temporal_grounding", "logical_adherence", "attention_recovery", "safe_coding")


@functools.lru_cache(maxsize=1)
def code() -> SimpleNamespace:
    """The vendor modules, checked once. mem0_eval imports its Azure client and Mem0 settings at import time; the client
    is a stub here, and nothing of Mem0 runs."""
    check(CLONE, COMMIT, BLOBS)
    if "client" not in sys.modules:
        stub = types.ModuleType("client")
        stub.CONFIG, stub.LLMClient, stub.get_openai_client = {}, None, None
        stub._base_url = stub._get_api_key = stub._parse_env_list = None
        sys.modules["client"] = stub
    for p in (CLONE / PM, CLONE / PM / "source"):
        if str(p) not in sys.path:
            sys.path.insert(0, str(p))
    mods = {n: importlib.import_module(n) for n in ("pm_judge", "pm_scorer", "longcontext_blended_close", "mem0_eval")}
    for m in mods.values():
        if not Path(m.__file__).resolve().is_relative_to((CLONE / PM).resolve()):
            sys.exit(f"{m.__name__} resolves to {m.__file__}, not TriggerBench's clone")
    return SimpleNamespace(judge=mods["pm_judge"], scorer=mods["pm_scorer"], blended=mods["longcontext_blended_close"],
                           mem0=mods["mem0_eval"])


@functools.lru_cache(maxsize=1)
def entries() -> list[dict]:
    """Every Base task in mem0_eval's order: CATEGORIES, then VARIANTS, a file's lines in order."""
    code()
    out = []
    for cat in CATEGORIES:
        for var in VARIANTS:
            path = CLONE / DATA / var / cat / f"{cat}_base.jsonl"
            if path.exists():
                out += [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]
    return out


def qid(entry: dict) -> str:
    return f"tb-{VARIANTS[entry['variant']]}-{entry['task_id']}"


def epoch(stamp: str) -> int:
    return calendar.timegm(dt.datetime.strptime(stamp, "%Y-%m-%dT%H:%M").timetuple())


def answer_messages(category: str, memories: list[str], trigger_text: str) -> tuple[str, str]:
    """_run_one_mem0's generation messages: the category's system prompt, then memories and the trigger."""
    mem_block = "\n".join(f"- {m}" for m in memories) if memories else "(no memories retrieved)"
    return code().blended.get_system_prompt(category), (
        "Relevant memories extracted from our conversation history:\n"
        f"{mem_block}\n\n"
        f"Latest user message:\n{trigger_text}\n\n"
        "Respond helpfully.")


class NoReply(RuntimeError):
    """A judge call with no valid reply: PMJudge tries 3 times, then gives the verdict ERROR, which scores wrong."""


def verdict(text: str):
    """A valid reply is what PMJudge.judge accepts: JSON, fenced or not, with verdict YES or NO."""
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        raw = (raw[:-3] if raw.endswith("```") else raw).strip()
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    got = data.get("verdict") if isinstance(data, dict) else None
    return got.upper() if isinstance(got, str) and got.upper() in ("YES", "NO") else None


class LedgerJudge:
    """The client PMJudge calls: complete_chat(messages, max_tokens, temperature), each call a ledger item. The few-shot
    turns between the system and the user message are fixed per category, so each set gets its own log and settings.
    live: open items are asked (3 asks, first valid counts); else only the logs are read and open items are listed."""

    def __init__(self, folder: Path, tag: str, live: bool, slots: int) -> None:
        self.folder, self.tag, self.live, self.slots = folder, tag, live, slots
        self.clients: dict[str, tuple] = {}
        self.open: list[tuple[str, str]] = []
        self.guard = threading.Lock()

    def _client(self, system: str, shots: str) -> tuple:
        name = hash16(system + "\n" + shots)
        with self.guard:
            if name not in self.clients:
                s = Settings(FOUR_O, temperature=0.0, max_tokens=JUDGE_MAX_TOKENS, shots=shots)
                log = self.folder / f"{name}.jsonl"
                log.parent.mkdir(parents=True, exist_ok=True)
                llm = OpenAIChat(log, s, slots=self.slots) if self.live else None
                man = Manifest(FOUR_O, EFFORT, s.cli)
                if llm:
                    require(llm, man)
                self.clients[name] = (Ledger(log), llm, man)
            return self.clients[name]

    def complete_chat(self, messages: list[dict], max_tokens: int, temperature: float) -> str:
        if (max_tokens, temperature, messages[0]["role"], messages[-1]["role"]) != (
                JUDGE_MAX_TOKENS, 0.0, "system", "user"):
            raise RuntimeError(f"unexpected judge call: {max_tokens} {temperature} {[m['role'] for m in messages]}")
        ledger, llm, man = self._client(messages[0]["content"], json.dumps(messages[1:-1]))
        item = Item(self.tag, messages[0]["content"], messages[-1]["content"], man, parse=verdict)
        choice = ledger.settle(item, llm) if llm else ledger.choose(item)
        if choice.status == "open":
            self.open.append(item.key)
        if choice.status != "valid":
            raise NoReply(f"{item.tag}: no valid reply ({choice.status}, {choice.asks} asks)")
        return choice.record["text"]
