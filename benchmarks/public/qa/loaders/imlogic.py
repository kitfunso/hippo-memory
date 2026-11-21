"""IMLogic conversation level, multiple choice (arXiv 2606.23283, Table 5), for hippo arms through qa/harness.py.

Authors' repository ThisIsCosine/IMLogic at 8823defc18ec (code MIT; data CC BY-NC-ND 4.0: scores only, no derived data
committed): the dialogue, qa_user00..19.json and eval/evaluate_common.py at that commit sit under
~/hippo-bench/datasets/imlogic/8823defc18ec/, read as JSON or text only. Dialogue item i pairs with qa_user{i:02d}.json
(evaluate_common.py:662-664). Ask timing: evaluate_single_user builds a user's memory bank from the whole dialogue item
once (evaluate_common.py:522), then asks every question (531-551), so every question here is asked after the last turn
(`ask_after` None). One turn is one hippo add, as in halumem.py; halumem.py's parsing does not fit by import, since it
reads its own file and dates each turn at its session start, while these turns carry their own timestamps, which the
authors' integration point receives (evaluate_on_conversation.py:15-29). top_k 30: "All methods use the same top-30
retrieval setting" (paper sec 5.1.2, App. C.2.2); the script default is 5. The search query is the raw `query`, as the
authors' retriever gets it (evaluate_common.py:532-533).
Global state (evaluate_common.py:251-273). UUID and Session Count come from the dialogue item, as theirs. Available
Memory Count is hippo's store size: every turn is one memory, the harness checks the adds the store took against that
count at ingest (harness.run_unit), and mem0/imlogic_openai.py checks it against the ingest record. Persona Summary is
the dialogue item's `persona_info`: the authors' code reads it from the dataset for every method (lines 259, 271-272),
not from the memory system, so every published Table 5 row had it; hippo keeps no persona summary of its own, and
leaving the line out would make hippo's prompt differ from theirs.
"""
from __future__ import annotations

import hashlib
import json
import random
import re
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

NAME = "IMLogic conversation level (multiple choice)"
TOPK = 30
REPO_SHA = "8823defc18ec94e377a835695ce9180678eb2b0e"
LICENCE = ("CC BY-NC-ND 4.0 (github ThisIsCosine/IMLogic, Hugging Face Cosineyx/IMLogic): scores only, "
           "no derived data committed")
ROOT = Path.home() / "hippo-bench" / "datasets" / "imlogic" / REPO_SHA[:12]
DIALOGUE = ROOT / "dataset" / "dialogue" / "HaluMem-Medium.jsonl"
QA = [ROOT / "dataset" / "qa" / f"qa_user{i:02d}.json" for i in range(20)]
DATA_FILES = [DIALOGUE, *QA]
# sha256 over "<name> <file sha256>" lines of DATA_FILES sorted by name; each file's own sha256 is in ROOT/SOURCE.txt
DATA_DIGEST = "7b15affc22fdb3fd02f6185a274ad080f62b11c77df2574a878bbfd70565ec8f"
DATE_FORMAT = "%b %d, %Y, %H:%M:%S"  # the dialogue's own turn timestamps, read as UTC as halumem.py reads HaluMem's
SHUFFLE_SEED = 42  # evaluate_common.py:158-163

OPTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"  # evaluate_common.py:18-19, verbatim
SYSTEM = "Follow the prompt exactly and return only the requested output."

# evaluate_common.py:21-45 (MULTIPLE_CHOICE_PROMPT_TEMPLATE), verbatim
TEMPLATE = """Role: Cognitive Evaluation Agent
You are an advanced conversational agent
equipped with a cognitive root memory system for personalization and logical reasoning.
Active_Root_Memory_Units:
Activated cognitive root memory units providing the logical framework for time-aware
personalization.
- Execution_Rules: The deterministic control laws and conflict resolution protocols.
- Personalized_Logical_Evidences: The temporal parameter matrix bounding the Agent's feasible decision region.
{global_state}
Retrieved Context:
The user's historical memories.
{context}
User Query:
The [Timestamp] at the beginning of the query indicates the exact time of the user's current request.
"{query}"
Candidate Responses:
{options_str}
Instructions:
Evaluate the candidate responses and select the optimal choice by adhering to the following rules:
1. Logic-Aware Personalization: Incorporate the Execution_Rules and Personalized_Logical_Evidences defined
in Active_Root_Memory_Units to contextualize and tailor the response.
2. Evidence-Grounded Alignment: Select the response that maximally aligns
with the user's actual needs, relying on the provided evidence.
Output Format:
Output only the letter of the best option (e.g., A, B, C, or D). Do not provide any explanation."""


def data_digest(files: list[Path]) -> str:
    lines = sorted(f"{p.name} {hashlib.sha256(p.read_bytes()).hexdigest()}\n" for p in files)
    return hashlib.sha256("".join(lines).encode()).hexdigest()


@lru_cache(maxsize=1)
def _users() -> tuple[dict, ...]:
    if (got := data_digest(DATA_FILES)) != DATA_DIGEST:
        raise RuntimeError(f"IMLogic data under {ROOT} digests to {got}, not the pinned {DATA_DIGEST}")
    with DIALOGUE.open(encoding="utf-8") as f:
        return tuple(json.loads(line) for line in f if line.strip())


@lru_cache(maxsize=20)
def _qa(i: int) -> tuple[dict, ...]:
    _users()  # the digest check covers the QA files too
    return tuple(json.loads(QA[i].read_text(encoding="utf-8")))


def _time(stamp: str) -> int:
    return int(datetime.strptime(stamp, DATE_FORMAT).replace(tzinfo=timezone.utc).timestamp())


def _turns(user: dict) -> list[dict]:
    return [{"role": t["role"], "content": t["content"], "timestamp": float(_time(t["timestamp"]))}
            for s in user["sessions"] for t in s["dialogue"]]


def conversations():
    """One user per uuid, every session's turns in file order, each dated at its own timestamp."""
    for u in _users():
        yield u["uuid"], _turns(u)


@lru_cache(maxsize=20)
def memory_count(user_index: int) -> int:
    """The memories hippo holds for the user once every turn is in: one per non-empty turn."""
    return sum(1 for t in _turns(_users()[user_index]) if t["content"].strip())


def gold(item: dict) -> str:
    return item.get("correct_answer") or item.get("options", {}).get("Correct", "")  # evaluate_common.py:553


def questions() -> list[dict]:
    """Every QA item of every user in file order; qid holds the dialogue index and the item's index in its file, the two
    numbers the authors seed the option shuffle with."""
    out = []
    for i, u in enumerate(_users()):
        for j, item in enumerate(_qa(i)):
            out.append({"qid": f"u{i:02d}-q{j:04d}", "user_id": u["uuid"], "user_index": i, "question_index": j,
                        "question": item.get("query", ""), "query_time": item.get("query_time"),
                        "options": item.get("options", {}), "gold": gold(item), "category": item.get("category"),
                        "query_type": item.get("query_type"), "ask_after": None})
    return out


def lettered_options(q: dict, seed: int = SHUFFLE_SEED) -> tuple[str, dict[str, dict[str, str]]]:
    """evaluate_common.py:312-333: the options in file order, string values only, shuffled by a Random seeded with
    "seed:user:question", then lettered A, B, ..."""
    items = [(k, v) for k, v in q["options"].items() if isinstance(v, str)]
    random.Random(f"{seed}:{q['user_index']}:{q['question_index']}").shuffle(items)
    letters = {OPTION_LETTERS[n]: {"option_key": k, "option_text": v} for n, (k, v) in enumerate(items)}
    return "\n".join(f"{c}. {o['option_text']}" for c, o in letters.items()), letters


def global_state(q: dict) -> str:
    """evaluate_common.py:251-273 with no override file, as the published runs."""
    u = _users()[q["user_index"]]
    persona = u.get("persona_info", "").strip()
    lines = ["Execution_Rules:",
             "- Prefer retrieved memories over generic assumptions.",
             "- If memories conflict, prioritize the most recent evidence-supported memory.",
             "- Do not fabricate facts that are not grounded in retrieved context.",
             "Personalized_Logical_Evidences:",
             f"- User UUID: {u.get('uuid', 'unknown')}",
             f"- Session Count: {len(u.get('sessions', []))}",
             f"- Available Memory Count: {memory_count(q['user_index'])}"]
    if persona:
        lines.append(f"- Persona Summary: {persona}")
    return "\n".join(lines)


def _shown_time(m: dict) -> str | None:
    """hippo's created_at in the dialogue's own timestamp form, which is the turn's timestamp back again."""
    at = m.get("created_at")
    return datetime.strptime(at, "%Y-%m-%dT%H:%M:%S.%fZ").strftime(DATE_FORMAT) if at else None


def context(memories: list[dict]) -> str:
    """evaluate_common.py:276-286; hippo keeps no memory type, so each line says "Unknown type" as theirs would."""
    if not memories:
        return "(No retrieved memories.)"
    return "\n".join(f"{n}. [{_shown_time(m) or 'Unknown time'}] ({m.get('memory_type') or 'Unknown type'}) "
                     f"{(m.get('memory') or '').strip()}" for n, m in enumerate(memories, start=1))


def prompt_query(q: dict) -> str:
    """evaluate_common.py:289-296."""
    query, when = (q.get("question") or "").strip(), q.get("query_time")
    if not query:
        return f"[{when}]" if when else ""
    return f"[{when}] {query}" if when and when not in query else query


def answer_prompt(q: dict, memories: list[dict]) -> tuple[str, str]:
    """The system message and the one user message call_llm_text sends (evaluate_common.py:238-239, 385-390)."""
    options_str, _ = lettered_options(q)
    return SYSTEM, TEMPLATE.format(global_state=global_state(q), context=context(memories), query=prompt_query(q),
                                   options_str=options_str)


def choice_letter(reply: str, valid: set[str]) -> str | None:
    """evaluate_common.py:336-346, verbatim in effect: the whole reply, else the first single capital letter word."""
    cleaned = reply.strip().upper()
    if cleaned in valid:
        return cleaned
    m = re.search(r"\b([A-Z])\b", cleaned)
    return m.group(1) if m and m.group(1) in valid else None


def is_correct(q: dict, reply: str) -> bool:
    """evaluate_common.py:553-560: the chosen option's text equals the gold; no valid letter is wrong."""
    _, letters = lettered_options(q)
    letter = choice_letter(reply, set(letters))
    return letter is not None and letters[letter]["option_text"] == q["gold"]
