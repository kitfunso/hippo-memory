"""HaluMem question answering, Medium or Long (Chen et al., arXiv 2511.03506), prereg Amendment 6 group B.

Authors' repository MemTensor/HaluMem at d653749586bf (`eval/`); data HF IAAR-Shanghai/HaluMem at cb04336aa1b7
(CC BY-NC-ND 4.0: scores only, no derived data committed), `HaluMem-Medium.jsonl` and `HaluMem-Long.jsonl` under
~/hippo-bench/datasets/halumem/. Variant by environment, the same on every stage: HALUMEM_VARIANT=medium (default) or long.
Both hold the same 20 users and 3,467 questions; Long adds 1,030 distractor sessions (`is_generated_qa_session`).
The authors ingest one session per add, then ask that session's questions (eval_memzero.py:189-254). Here a turn is one add,
so a question is asked after the last turn of its session (`ask_after`). top_k 20 is theirs (eval_memzero.py:101,283,333).
Run `python -I loaders/halumem.py secondary --out DIR` after scoring for the Correct, Hallucination and Omission counts.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

VARIANT = os.environ.get("HALUMEM_VARIANT", "medium").lower()
if VARIANT not in ("medium", "long"):
    sys.exit(f"HALUMEM_VARIANT must be medium or long, not {VARIANT!r}")
NAME = f"HaluMem-{VARIANT.title()} (question answering)"
TOPK = 20
LICENCE = "CC BY-NC-ND 4.0 (Hugging Face IAAR-Shanghai/HaluMem): scores only, no derived data committed"
DATA = Path.home() / "hippo-bench" / "datasets" / "halumem" / f"HaluMem-{VARIANT.title()}.jsonl"
DATA_FILES = [DATA]

# prompts.py:1-37 (PROMPT_MEMZERO), verbatim; eval_memzero.py:244-247 formats it with context and question and sends it
# as the only message, so the system prompt is empty.
PROMPT_MEMZERO = """
    You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.

    # CONTEXT:
    You have access to memories from two speakers in a conversation. These memories contain
    timestamped information that may be relevant to answering the question.

    # INSTRUCTIONS:
    1. Carefully analyze all provided memories from both speakers
    2. Pay special attention to the timestamps to determine the answer
    3. If the question asks about a specific event or fact, look for direct evidence in the memories
    4. If the memories contain contradictory information, prioritize the most recent memory
    5. If there is a question about time references (like "last year", "two months ago", etc.),
       calculate the actual date based on the memory timestamp. For example, if a memory from
       4 May 2022 mentions "went to India last year," then the trip occurred in 2021.
    6. Always convert relative time references to specific dates, months, or years. For example,
       convert "last year" to "2022" or "two months ago" to "March 2023" based on the memory
       timestamp. Ignore the reference while answering the question.
    7. Focus only on the content of the memories from both speakers. Do not confuse character
       names mentioned in memories with the actual users who created those memories.
    8. The answer should be less than 5-6 words.

    # APPROACH (Think step by step):
    1. First, examine all memories that contain information related to the question
    2. Examine the timestamps and content of these memories carefully
    3. Look for explicit mentions of dates, times, locations, or events that answer the question
    4. If the answer requires calculation (e.g., converting relative time references), show your work
    5. Formulate a precise, concise answer based solely on the evidence in the memories
    6. Double-check that your answer directly addresses the question asked
    7. Ensure your final answer is specific and avoids vague time references

    {context}

    Question: {question}

    Answer:
    """

# eval_memzero.py:55-58, verbatim; the context is this with the user's name and the memories as json (eval_memzero.py:124-131).
TEMPLATE_MEM0 = """Memories for user {user_id}:

    {memories}
"""

# eval_tools.py:218-283 (EVALUATION_PROMPT_FOR_QUESTION), verbatim, one user message (eval_tools.py:365-370).
JUDGE_PROMPT = """You are an **evaluation expert for AI memory system question answering**.
Based **only** on the provided **“Question”**, **“Reference Answer”**, and **“Key Memory Points”** (the essential facts needed to derive the reference answer), strictly evaluate the **accuracy** of the **“Memory System Response.”** Classify it as one of **“Correct”**, **“Hallucination”**, or **“Omission.”** Do **not** use any external knowledge or subjective inference. Finally, output your judgment **strictly** in the specified JSON format.

# Evaluation Criteria

## Answer Type Classification

### 1. Correct

* The “Memory System Response” accurately answers the “Question,” and its content is **semantically equivalent** to the “Reference Answer.”
* It contains **no contradictions** with the “Key Memory Points” or “Reference Answer.”
* It introduces **no unsupported details** beyond the “Key Memory Points” that could alter the conclusion.
* Synonyms, paraphrasing, and reasonable summarization are acceptable.

### 2. Hallucination

* The “Memory System Response” includes information or facts that **contradict or are inconsistent** with the “Reference Answer” or the “Key Memory Points.”
* When the “Reference Answer” is labeled as *unknown/uncertain*, yet the response provides a specific verifiable fact or conclusion.
* Extra irrelevant information that does **not change** the conclusion is **not** considered hallucination by itself; however, if it **changes or misleads** the conclusion, or **contradicts** the “Key Memory Points,” it should be judged as a **Hallucination**.

### 3. Omission

* The response is **incomplete** compared to the “Reference Answer.”
* It explicitly states “don’t know,” “can’t remember,” or “no related memory,” even though relevant information exists in the “Key Memory Points.”
* For multi-element questions, **all elements must be correct and present**; omission of **any** element is considered an **Omission**.

## Priority Rules (Conflict Handling)

* If the response contains **both missing necessary information** and **fabricated/contradictory information**, classify it as **Hallucination**.
* If there is **no fabrication/contradiction** but some necessary information is missing, classify it as **Omission**.
* Only when the meaning is **fully equivalent** to the reference answer should it be classified as **Correct**.

## Detailed Guidelines and Tolerance

* Equivalent expressions of numbers, times, and units are acceptable, but the **numerical values themselves must not differ**.
* For multi-element questions, **all elements must be complete and accurate**; missing any element counts as **Omission**.
* If the reference answer is *“unknown / cannot be determined”* and the system provides a definite fact, that is a **Hallucination**.
  If the system also answers *“unknown”* (without guessing), it may be **Correct**.
* The evaluation must rely **only** on the *Reference Answer*, *Key Memory Points*, and *System Response* — no external context, world knowledge, or speculative reasoning is allowed.

# Information for Evaluation

* **Question:**
  {question}

* **Reference Answer:**
  {reference_answer}

* **Key Memory Points:**
  {key_memory_points}

* **Memory System Response:**
  {response}

# Output Requirements

Please provide your evaluation result **strictly** in the JSON format below.
Do **not** add any extra explanation or comments outside the JSON block.

```json
{{
  "reasoning": "Provide a concise and traceable evaluation rationale: first compare the system’s response with the Key Memory Points (which were correctly used, which were missing, and whether there was any fabrication/contradiction), then assess its consistency with the Reference Answer, and finally state the classification basis.",
  "evaluation_result": "Correct | Hallucination | Omission"
}}
```
"""

NAME_RE = re.compile(r"Name:\s*(.*?); Gender:")  # eval_memzero.py:139
DATE_FORMAT = "%b %d, %Y, %H:%M:%S"  # eval_memzero.py:184
JSON_BLOCK = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)  # llms.py:89
FENCE = re.compile(r"```[a-zA-Z0-9]*\n([\s\S]*?)\n```")
LABELS = ("Correct", "Hallucination", "Omission")  # evaluation.py:342-353


@lru_cache(maxsize=1)
def _users() -> tuple[dict, ...]:
    with DATA.open(encoding="utf-8") as f:
        return tuple(json.loads(line) for line in f if line.strip())


def _name(user: dict) -> str:
    m = NAME_RE.search(user["persona_info"])
    if not m:
        raise ValueError(f"no name in persona_info of {user['uuid']}")  # the authors raise too (eval_memzero.py:145)
    return m.group(1).strip()


def _start(session: dict) -> int:
    return int(datetime.strptime(session["start_time"], DATE_FORMAT).replace(tzinfo=timezone.utc).timestamp())


def conversations():
    """One user per uuid. Turns are every session's dialogue in file order (Long's distractor sessions included, as
    eval_memzero.py:189 adds them), each dated at its session's start_time in UTC as the authors do, plus its index in
    the session in seconds to keep order. The role is "user" or "assistant"."""
    for u in _users():
        yield u["uuid"], [{"role": t["role"], "content": t["content"], "timestamp": float(_start(s) + j)}
                          for s in u["sessions"] for j, t in enumerate(s["dialogue"])]


def questions() -> list[dict]:
    """Every question of every non-distractor session (eval_memzero.py:196-231, evaluation.py:51-102), asked after that
    session's last turn. qid is the user's uuid and the question's order within the user, the same in Medium and Long."""
    out = []
    for u in _users():
        seen, n = 0, 0
        for s in u["sessions"]:
            seen += len(s["dialogue"])
            if s.get("is_generated_qa_session"):
                continue
            for q in s.get("questions", []):
                out.append({"qid": f"{u['uuid']}-q{n:04d}", "user_id": u["uuid"], "user_name": _name(u),
                            "question": q["question"], "gold": q["answer"], "category": q["question_type"],
                            "difficulty": q["difficulty"], "ask_after": seen,
                            "key_memory_points": "\n".join(i["memory_content"] for i in q["evidence"])})  # evaluation.py:184
                n += 1
    return out


def answer_prompt(q: dict, memories: list[dict]) -> tuple[str, str]:
    """The authors' prompt: each memory as "<date>: <text>", the list as json with indent 4 inside TEMPLATE_MEM0, then
    PROMPT_MEMZERO (eval_memzero.py:124-131,244-247). Our memory text is a stored turn, "user: ..." or "assistant: ...",
    where Mem0's is an extracted fact."""
    lines = [f"{m['created_at']}: {m['memory']}" for m in memories]
    context = TEMPLATE_MEM0.format(user_id=q["user_name"], memories=json.dumps(lines, indent=4))
    return "", PROMPT_MEMZERO.format(context=context, question=q["question"])


def label_of(reply: str) -> str | None:
    """The `evaluation_result` of the judge's JSON: the authors' ```json block (llms.py:89-95), else the whole reply as
    JSON, since the codex judge answers as a JSON-only function. None when there is no JSON or the value is none of the
    three labels: the authors count that item invalid (evaluation.py:342-344); here it is asked again, at most 3 times."""
    m = JSON_BLOCK.search(reply)
    raw = m[1].strip() if m else (FENCE.fullmatch(reply.strip()) or [None, reply.strip()])[1]
    try:
        v = json.loads(raw)
    except ValueError:
        return None
    r = v.get("evaluation_result") if isinstance(v, dict) else None
    return r if r in LABELS else None


def parse(reply: str) -> bool | None:
    """Correct counts as correct (evaluation.py:346-347); Hallucination and Omission are both not correct."""
    r = label_of(reply)
    return None if r is None else r == "Correct"


def judge(q: dict, answer: str):
    prompt = JUDGE_PROMPT.format(question=q["question"], reference_answer=q["gold"],
                                 key_memory_points=q["key_memory_points"], response=answer)
    return "llm", "", prompt, parse


def secondary(out: Path) -> str:
    """Correct, Hallucination and Omission counts per arm and per question type, read from the judge reply the call log
    settles for each verdict (qa/ledger.py), smoke items left out; an exhausted answer or verdict is counted apart.
    Run after the score stage."""
    import argparse
    sys.path[:0] = [str(Path(__file__).resolve().parents[1])]
    import harness  # noqa: E402  (imported here: harness imports this module while it runs)

    a = argparse.Namespace(stage="score", bench="halumem", out=out, limit=0, slots=1, port_base=0)
    mod, qs = harness.setup(a)
    answers = harness.all_answers(a, mod, qs)
    llm, _ = harness.llm_items(mod, qs, answers)
    key, ledger = harness.judge_key(a, llm, answers), harness.Ledger(out / "calls-judge.jsonl")
    got = {(key[j]["arm"], key[j]["qid"]): ledger.choose(item) for j, item in harness.judge_items(key, llm).items()}
    harness.unsettled(got, "verdicts")
    primary, note = harness.primary_ids(a, mod, [q["qid"] for q in qs])
    cat, cols, rows = {q["qid"]: q["category"] for q in qs}, (*LABELS, "Exhausted"), {}
    for arm in harness.ARMS:
        for qid in primary:
            c = got.get((arm, qid))
            label = label_of(c.record["text"]) if c and c.status == "valid" else "Exhausted"
            for name in ("all", cat[qid]):
                rows.setdefault((arm, name), dict.fromkeys(cols, 0))[label] += 1
    lines = [f"{NAME}: label counts from the judge replies the call log settles; {note}"]
    for (arm, name), c in sorted(rows.items(), key=lambda kv: (kv[0][1] != "all", kv[0][1], kv[0][0])):
        n = sum(c.values())
        lines.append(f"{name:>28} {arm:>9} n={n:5d}  " + "  ".join(f"{lab} {c[lab]:5d} ({100 * c[lab] / n:4.1f}%)" for lab in cols))
    text = "\n".join(lines)
    (out / "secondary.txt").write_text(text + "\n", encoding="utf-8")
    return text


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description=secondary.__doc__)
    ap.add_argument("command", choices=("secondary",))
    ap.add_argument("--out", type=Path, required=True)
    print(secondary(ap.parse_args().out))
