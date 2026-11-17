"""MemFail's own code, imported from the pinned local clone; the repo carries no licence, so none of it is copied here.

ishirgarg/MemFail 61ab3028: each task's load_dataset and build_chat_dataset (playground/*/evaluate_*.py), the test-taker
prompt (src/prompt_templates.py) and the gpt-5-mini judges (playground/*/analyze_errors.py), which call the OpenAI client
they are given. LedgerClient is that client: each create call is a ledger item, asked through qa/openai_llm.py.
"""
from __future__ import annotations

import functools
import importlib.util
import json
import re
import sys
import threading
import types
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

sys.path[:0] = [str(Path(__file__).resolve().parents[1])]
from qa.ledger import Item, Ledger, Manifest, require  # noqa: E402
from qa.openai_llm import OpenAIChat, Settings  # noqa: E402
from qa.vendor_pin import check  # noqa: E402

CLONE = Path.home() / "hippo-bench" / "vendor" / "MemFail"
COMMIT = "61ab3028a6dc4a67b222f0d3a37a62e1d479ade9"
BLOBS = {  # git ls-tree at COMMIT
    "src/__init__.py": "b0e1f382c25e47484ef639c0c73fdcf15f8cd445",
    "src/chat.py": "c64b30afd00b0975ab7bdf800e751981b6bde506",
    "src/dataset.py": "2b5d8ee0d404bdb2cdaa0a32da6c90379c3c4bf7",
    "src/evaluation.py": "723ebc8380a46e36aa94a4dfeeecef5bbd165e81",
    "src/llm.py": "271e2da848f9cd62a9b65b17cceea5f822e5b03f",
    "src/memory.py": "152b6a6f186ab780cace8fc0212999b1a4393c7b",
    "src/prompt_templates.py": "74f8c74c69d2c7dbbc59bf2849a1016b7dd49776",
    "src/tokenizer.py": "a4f77cc8d027840c37d5b650ca7b42430ded5123",
    "src/types.py": "cec8fb7a5528b5f54630a222fd1b003425a28760",
    "playground/conditional_facts/evaluate_conditional_facts.py": "cd284ddf629f4d35dfac03984f605eed27b9c5a0",
    "playground/conditional_facts/analyze_errors.py": "f5375ae2e1cf3f0ed960a78d23c0c32d5f60dc48",
    "playground/coexisting_facts/evaluate_coexisting_facts.py": "3710736b9844319fa65c183d104523dc4196edab",
    "playground/coexisting_facts/analyze_errors.py": "a109484f2308f5bd7c879503faf186d0801255d7",
    "playground/custom_persona_retrieval/evaluate_persona_retrieval.py": "5cdaacc0ff4fe7b57270e0d65b7e2398c96a29bd",
    "playground/custom_persona_retrieval/analyze_errors.py": "f63799e4752cd1c46d2f0c91a28d3d41c578840d",
    "playground/long_hop/evaluate_long_hop.py": "4aa832bb6568ef840e5bf0ee5f1486f64e8e6614",
    "playground/long_hop/analyze_errors.py": "e54c89673714ff3aa248482d066c8d573226b23a",
    "datasets/conditional_facts/easy/conditional_facts_dataset_easy.csv": "720461946af4a696574190c022d5b2a35c36a97c",
    "datasets/conditional_facts/hard/conditional_facts_dataset_hard.csv": "219a455033101cdc4d18956394a7387675eb3443",
    "datasets/coexisting_facts/coexisting_facts_dataset.csv": "9546e0556cda9d22fbdef65bf70b5e8b886d6691",
    "datasets/custom_persona_retrieval/persona_dataset.csv": "0aa9f4bdfcf46b648fde72cc4448ce49a8c8d6c4",
    "datasets/long_hop/long_hop_chains.csv": "f0cecf362120ef53a68a9c4370cac1cb7c53f0c6",
}
MODEL = "gpt-5-mini"  # LLM_MODEL and JUDGE_MODEL of all four task scripts; its one snapshot is below
SNAPSHOT = "gpt-5-mini-2025-08-07"
GPT5_MINI = Settings(SNAPSHOT, temperature=None)  # src/llm.py OpenAILLM.query sends the model and one user message only
EFFORT = "default"  # no reasoning_effort is sent, so the API's default applies; the ledger compares this label
SEED, TOPK = 42, 5  # SEED and NUM_MEMORIES of every task script


@dataclass(frozen=True)
class Task:
    folder: str  # playground/<folder>
    script: str
    csv: str
    user: str  # the script's --shared-user-id; here the hippo store's user
    hard: bool = False

    @property
    def evaluate(self) -> str:
        return f"playground/{self.folder}/{self.script}"

    @property
    def judge(self) -> str:
        return f"playground/{self.folder}/analyze_errors.py"


TASKS = {  # Figure 1's panels, in its order; conditional_facts.sh --use-hard picks the hard CSV and --hard judge
    "coexisting": Task("coexisting_facts", "evaluate_coexisting_facts.py",
                       "datasets/coexisting_facts/coexisting_facts_dataset.csv", "coexisting_facts_eval_user"),
    "conditional": Task("conditional_facts", "evaluate_conditional_facts.py",
                        "datasets/conditional_facts/easy/conditional_facts_dataset_easy.csv", "conditional_facts_eval_user"),
    "conditional-hard": Task("conditional_facts", "evaluate_conditional_facts.py",
                             "datasets/conditional_facts/hard/conditional_facts_dataset_hard.csv",
                             "conditional_facts_eval_user", hard=True),
    "persona": Task("custom_persona_retrieval", "evaluate_persona_retrieval.py",
                    "datasets/custom_persona_retrieval/persona_dataset.csv", "persona_retrieval_eval_user"),
    "long-hop": Task("long_hop", "evaluate_long_hop.py", "datasets/long_hop/long_hop_chains.csv", "long_hop_eval_user"),
}


@functools.lru_cache(maxsize=1)
def src():
    """The vendor's src package, which the evaluate scripts and judges import from the clone root; checked once."""
    check(CLONE, COMMIT, BLOBS)
    if str(CLONE) not in sys.path:
        sys.path.insert(0, str(CLONE))
    pkg = importlib.import_module("src")
    if Path(pkg.__file__).resolve().parent != (CLONE / "src").resolve():
        sys.exit(f"`src` resolves to {pkg.__file__}, not MemFail's")
    return pkg


def module(rel: str):
    """A vendor playground file as a module, loaded once; the evaluate scripts' playground.utils imports product
    wrappers that commit bc2dd1b removed, so it is a stub here, and none of its functions run."""
    src()
    if "playground.utils" not in sys.modules:
        stub = types.ModuleType("playground.utils")
        stub.UUIDEncoder = json.JSONEncoder
        for name in ("add_api_key_arg", "add_memory_system_args", "create_memory_system", "resolve_api_key"):
            setattr(stub, name, None)
        sys.modules["playground.utils"] = stub
    name = "memfail_" + re.sub(r"\W", "_", rel)
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, CLONE / rel)
        sys.modules[name] = mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    return sys.modules[name]


def chat_dataset(task: str):
    """(storage conversations as lists of fact texts, question rows, their queries) as the task script builds them."""
    t, ev = TASKS[task], module(TASKS[task].evaluate)
    path = CLONE / t.csv
    if task == "coexisting":  # coexisting_facts.sh: FACTS_PER_GROUP=1, COEXIST_IN_SAME_CHAT=false
        ds, n, rows = ev.build_chat_dataset(ev.load_dataset(path), False, 1, SEED)
    elif task == "long-hop":  # long_hop.sh: all three hop counts, no limit, NUM_FACTS=1
        ds, n, rows, _ = ev.build_chat_dataset(ev.load_dataset(path, [1, 2, 3], None, SEED), 1, SEED)
    else:  # FACTS_PER_GROUP=1
        ds, n, rows = ev.build_chat_dataset(ev.load_dataset(path), 1, SEED)
    convs = ds.conversations
    if any(g for c in convs[:n] for _, g in c.queries) or not all(g for c in convs[n:] for _, g in c.queries):
        raise RuntimeError(f"{task}: a storage turn is graded or a question turn is not")
    if any(len(c.queries) != 1 for c in convs[n:]):
        raise RuntimeError(f"{task}: a question conversation has more than one turn")
    return [[q for q, _ in c.queries] for c in convs[:n]], rows, [c.queries[0][0] for c in convs[n:]]


def prompt(query: str, memories: str, history: list[tuple[str, str]], graded: bool) -> str:
    """ConversationHistoryPromptTemplate.format over a conversation of (raw query, response) turns."""
    pkg = src()
    conv = pkg.Conversation(conversation_id=None, messages=tuple(
        pkg.Message(prompt="", raw_query=q, response=r, conversation_id=None) for q, r in history))
    return pkg.ConversationHistoryPromptTemplate().format(query, memories, conv, graded=graded)


def memories_text(memories: list[str]) -> str:
    """Mem0MemorySystem.get_memories at 7ccb5b8 src/memory.py:171-176, the generic wrapper: a "- " line per hit."""
    return "\n".join(f"- {m}" for m in memories)


ROW_FIELDS = {  # the dataset fields each evaluate script merges into a graded trace, before the trace fields
    "coexisting": ("preference_category", "preferences", "preference_facts", "ground_truth_answer"),
    "conditional": ("entity", "entity_category", "behavior", "condition_type", "condition", "entity_facts",
                    "question_context", "condition_met", "ground_truth_answer"),
    "persona": ("entity", "distractor", "entity_facts", "question_type", "ground_truth_answer"),
    "long-hop": ("example_id", "hop_count", "facts", "answer_chain", "ground_truth_answer"),
}
ROW_FIELDS["conditional-hard"] = ROW_FIELDS["conditional"]


def graded_trace(task: str, row: dict, query: str, memories: str, response: str, formatted: str, usage: dict) -> dict:
    """One graded trace as the task's evaluate script writes it (its graded_traces loop)."""
    src()
    out = {k: row[k] for k in ROW_FIELDS[task]}
    if task == "long-hop":
        out.update(support_set_size=len(row["facts"]), question_stem=row["graded_question_stem"])
    out.update(question=query)
    if task == "long-hop":
        out.update(choices=row["choices"], correct_choice=row["correct_choice"])
    pin, pout = usage.get("prompt_tokens") or 0, usage.get("completion_tokens") or 0
    return {**out, "retrieved_memories": memories, "llm_response": response, "formatted_prompt": formatted,
            "conversation_id": None, "eval_input_tokens": pin, "eval_output_tokens": pout,
            "eval_cost": sys.modules["src.llm"].compute_cost(MODEL, pin, pout)}


class NoReply(RuntimeError):
    """A judge call with no valid reply: the vendor's retry loop then gives up and marks the trace analysis_error."""


class LedgerClient:
    """The OpenAI client the vendor judges call. live: open items are asked (3 asks each, first valid counts); else
    only the log is read and any open item is listed, so the score stage never grades on a partial log."""

    def __init__(self, folder: Path, tag: str, live: bool, slots: int, batches: bool = False) -> None:
        self.folder, self.tag, self.live, self.slots, self.batches = folder, tag, live, slots, batches
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        self.clients: dict[str, tuple] = {}
        self.open: list[tuple[str, str]] = []
        self.guard = threading.Lock()  # a judge asks one schema from many threads; two clients on one log lose lines

    def _client(self, name: str, fmt: str) -> tuple:
        with self.guard:
            return self._client_locked(name, fmt)

    def _client_locked(self, name: str, fmt: str) -> tuple:
        if name not in self.clients:
            s = Settings(SNAPSHOT, temperature=None, response_format=fmt)
            log = self.folder / f"{name}.jsonl"
            llm = OpenAIChat(log, s, slots=self.slots) if self.live else None
            man = Manifest(SNAPSHOT, EFFORT, s.cli)
            if llm:
                require(llm, man)
            self.clients[name] = (Ledger(log), llm, man, fmt)
        if self.clients[name][3] != fmt:
            raise RuntimeError(f"two schemas named {name}")
        return self.clients[name]

    def create(self, *, model: str, messages: list[dict], response_format: dict):
        if model != MODEL or [m["role"] for m in messages] != ["system", "user"]:
            raise RuntimeError(f"unexpected judge call: {model} {[m['role'] for m in messages]}")
        name = response_format["json_schema"]["name"]
        ledger, llm, man, _ = self._client(name, json.dumps(response_format))
        user = messages[1]["content"]
        item = Item(f"{self.tag} {name}", messages[0]["content"], user, man, parse=reply_parse(user, self.batches))
        choice = ledger.settle(item, llm) if self.live else ledger.choose(item)
        if choice.status == "open":
            self.open.append(item.key)
        if choice.status != "valid":
            raise NoReply(f"{item.tag}: no valid reply ({choice.status}, {choice.asks} asks)")
        u = choice.record.get("usage") or {}
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=choice.record["text"]))],
                               usage=SimpleNamespace(prompt_tokens=u.get("prompt_tokens") or 0,
                                                     completion_tokens=u.get("completion_tokens") or 0))


def reply_parse(user: str, batches: bool):
    """A valid reply is what the vendor call accepts: JSON (json.loads), and for a persona batch a verdict for every
    id 1..n (_call_batch); anything else it retries, as the ledger asks again."""
    n = len(re.findall(r"^\[id=\d+\]$", user, re.M)) if batches else 0

    def parse(text: str):
        try:
            data = json.loads(text)
        except ValueError:
            return None
        if not isinstance(data, dict):
            return None
        if n:
            ids = {r.get("id") for r in data.get("results") or [] if isinstance(r, dict)}
            if not set(range(1, n + 1)) <= ids:
                return None
        return data
    return parse
