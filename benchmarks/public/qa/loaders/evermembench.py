from __future__ import annotations

import datetime as dt
import json
import os
import re
from pathlib import Path

NAME = "EverMemBench-Dynamic"
TOPK = 10
LICENCE = "Apache-2.0 (Hugging Face EverMind-AI/EverMemBench-Dynamic)"
DATA = Path.home() / "hippo-bench" / "datasets" / "evermembench"
# SHORTCUT: EVERMEM_TOPICS limits a smoke run to one topic (10k adds); a full run leaves it unset.
TOPICS = tuple(os.environ.get("EVERMEM_TOPICS", "01,02,03,04,05").split(","))
assert set(TOPICS) <= {"01", "02", "03", "04", "05"}, f"EVERMEM_TOPICS holds an unknown topic: {TOPICS}"
DATA_FILES = [p for t in TOPICS for p in (DATA / t / "dialogue.json", DATA / t / f"qa_{t}.json")]

MC_PROMPT = """You are a rigorous question-answering assistant. You will be given retrieved memories from
a multi-person group chat and one multiple-choice question with four options.
Your task is to choose the single best answer (A/B/C/D) based ONLY on the provided memories.

Rules:
1. Use only information explicitly stated in the memories or directly entailed by them.
   Do NOT use outside knowledge, assumptions, or guesses beyond the memories.
2. The memories come from group chat conversations involving multiple participants.
   Pay attention to who said what and when.
3. If multiple options seem plausible, choose the one most strongly and directly supported
   by the memories.
4. If the memories do not provide enough information to be certain, you MUST still pick one
   option (A/B/C/D). Choose the option that is least inconsistent with the memories.
5. Pay special attention to timestamps to determine when events occurred.
6. If memories contain contradictory information, prioritize the most recent memory.
7. Do NOT output any reasoning, explanation, punctuation, or extra text.

Output format (must be followed exactly):
Output ONLY a single uppercase letter: A or B or C or D

[MEMORIES]
{context}

[QUESTION]
{question}

[OPTIONS]
{options}
"""

OE_PROMPT = """You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories. You will be given retrieved memories from a multi-person group chat and one open-ended question.
Your task is to answer the question using ONLY the information in the memories.

# INSTRUCTIONS:
1. Carefully analyze all provided memories from the group chat.
2. Pay special attention to timestamps to determine when events occurred.
3. If the question asks about a specific event or fact, look for direct evidence in the memories.
4. If memories contain contradictory information, prioritize the most recent memory.
5. If the question involves time references (like "last year", "two months ago"), calculate the actual date based on the memory's timestamp.
6. Always convert relative time references to specific dates, months, or years in your answer.
7. Pay attention to who said what - the memories may involve multiple participants.
8. The answer should be concise and specific (under 5-6 words when possible).
9. Do NOT output any reasoning steps, explanations, or extra text beyond the final answer.

# APPROACH (Think step by step internally):
1. Examine all memories that contain information related to the question.
2. Examine timestamps and content carefully.
3. Look for explicit mentions of dates, times, locations, or events that answer the question.
4. If the answer requires calculation (e.g., converting relative time references), do so.
5. Formulate a precise, concise answer based solely on the evidence in the memories.

Output format (must be followed exactly):
Output ONLY the answer text

[MEMORIES]
{context}

[QUESTION]
{question}
"""

JUDGE_SYSTEM = "You are an expert grader that determines if answers to questions match a gold standard answer.\n"

JUDGE_PROMPT = """Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given:
    (1) a question (about a multi-person group chat),
    (2) a 'gold' (ground truth) answer,
    (3) a generated answer
which you will score as CORRECT/WRONG.

The questions are about events, facts, or details mentioned in multi-person group chat conversations.
The gold answer is usually a concise answer that includes the key information.

For example:
Question: What project was announced on January 9th?
Gold answer: Carbon Emission Accounting Platform

The generated answer might be longer, but you should be generous with your grading -
as long as it contains the same key information as the gold answer, it should be CORRECT.

For time-related questions, the gold answer will be a specific date/time.
The generated answer might use different formats (e.g., "May 7th" vs "7 May" vs "2025-05-07"),
but as long as it refers to the same date/time, it should be CORRECT.

For the specific window of date, a +/- 1 day difference is acceptable due to timezone processing variations.

For multiple choice questions where the gold answer is a letter (A/B/C/D),
the generated answer should match exactly to be CORRECT.

Now grade this:
Question: {question}
Gold answer: {golden_answer}
Generated answer: {generated_answer}

First, provide a short (one sentence) explanation of your reasoning,
then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response.

Return the label in JSON format with the key "label": {{"label": "CORRECT"}} or {{"label": "WRONG"}}
"""

EMPTY_CONTEXT = "(No memories retrieved)"
LEAD = re.compile(r"^user: ")


def _ts(time_str: str) -> float:
    t = dt.datetime.strptime(time_str.strip(), "%Y-%m-%d %H:%M:%S")
    return t.replace(tzinfo=dt.timezone.utc).timestamp()


def conversations():
    for t in TOPICS:
        days = json.loads((DATA / t / "dialogue.json").read_text(encoding="utf-8"))
        turns = []
        for day in sorted(days, key=lambda d: d["date"]):
            for group, msgs in day["dialogues"].items():
                for m in msgs or []:
                    text = m.get("dialogue", "") or m.get("text", "")
                    turns.append({"role": "user", "content": f"[Group: {group}][Speaker: {m['speaker']}]{text}",
                                  "timestamp": _ts(m["time"])})
        yield t, turns


def questions() -> list[dict]:
    out = []
    for t in TOPICS:
        for x in json.loads((DATA / t / f"qa_{t}.json").read_text(encoding="utf-8")):
            opts = x.get("options")
            mc = bool(opts and isinstance(opts, dict) and len(opts) > 0)
            q = {"qid": x["id"], "user_id": t, "question": x["Q"], "gold": x["A"],
                 "category": "_".join(x["id"].split("_")[:-2]), "ask_after": None,
                 "qtype": "multiple_choice" if mc else "open_ended"}
            if mc:
                q["choices"] = [f"{k}. {opts[k]}" for k in sorted(opts)]
            out.append(q)
    return out


def _context(memories: list[dict]) -> str:
    if not memories:
        return EMPTY_CONTEXT
    return "\n".join(f"- {m['created_at']}: {LEAD.sub('', m['memory'], count=1)}" for m in memories)


def answer_prompt(q: dict, memories: list[dict]) -> tuple[str, str]:
    ctx = _context(memories)
    if q["qtype"] == "multiple_choice":
        return "", MC_PROMPT.format(context=ctx, question=q["question"], options="\n".join(q["choices"]))
    return "", OE_PROMPT.format(context=ctx, question=q["question"])


def parse_mc_answer(response: str) -> str:
    if response.startswith("[LLM_CALL_FAILED]"):
        return "[FAILED]"
    response = response.strip().upper()
    if not response:
        return "[EMPTY]"
    if len(response) == 1 and response in "ABCD":
        return response
    match = re.search(r'\b([ABCD])[.):,\s]', response)
    if match:
        return match.group(1)
    match = re.search(r'(?:answer|choice|option|select)[:\s]+([ABCD])\b', response, re.IGNORECASE)
    if match:
        return match.group(1).upper()
    if response[0] in "ABCD" and (len(response) == 1 or not response[1].isalpha()):
        return response[0]
    if response[-1] in "ABCD" and (len(response) == 1 or not response[-2].isalpha()):
        return response[-1]
    return "[INVALID]"


def _eval_parse_mc(response: str) -> str:
    response = response.strip().upper()
    if not response:
        return ""
    if len(response) == 1 and response in "ABCD":
        return response
    match = re.search(r'\b([ABCD])[.):,\s]', response)
    if match:
        return match.group(1)
    match = re.search(r'(?:answer|choice|option|select)[:\s]+([ABCD])\b', response, re.IGNORECASE)
    if match:
        return match.group(1).upper()
    if response[0] in "ABCD" and (len(response) == 1 or not response[1].isalpha()):
        return response[0]
    if response[-1] in "ABCD" and (len(response) == 1 or not response[-2].isalpha()):
        return response[-1]
    return response


def eval_mc(generated: str, golden_answer: str) -> bool:
    generated = generated.strip()
    if generated.startswith("[") and generated.endswith("]"):
        return False
    golden = golden_answer.strip().upper()
    if len(golden) > 1 and golden[0] in "ABCD" and golden[1] in ".):":
        golden = golden[0]
    generated = _eval_parse_mc(generated)
    return generated == golden


def _authors_judge_parse(content: str) -> bool:
    try:
        if "```json" in content:
            json_start = content.find("```json") + 7
            json_end = content.find("```", json_start)
            content_json = content[json_start:json_end].strip()
        elif "```" in content:
            json_start = content.find("```") + 3
            json_end = content.find("```", json_start)
            content_json = content[json_start:json_end].strip()
        elif "{" in content and "}" in content:
            json_start = content.find("{")
            json_end = content.rfind("}") + 1
            content_json = content[json_start:json_end]
        else:
            content_json = content
        result = json.loads(content_json)
        label = result.get("label", "WRONG")
        if isinstance(label, dict):
            label = label.get("label", "WRONG")
        if isinstance(label, str):
            label = label.strip().upper()
        else:
            label = "WRONG"
        return label == "CORRECT"
    except (json.JSONDecodeError, KeyError):
        label = "CORRECT" if "CORRECT" in content.upper() and "WRONG" not in content.upper() else "WRONG"
        return label == "CORRECT"


def parse(reply: str) -> bool | None:
    up = reply.upper()
    if "CORRECT" not in up and "WRONG" not in up:
        return None
    return _authors_judge_parse(reply)


def judge(q: dict, answer: str):
    if q["qtype"] == "multiple_choice":
        return "match", eval_mc(parse_mc_answer(answer), q["gold"])
    return "llm", JUDGE_SYSTEM, JUDGE_PROMPT.format(question=q["question"], golden_answer=q["gold"],
                                                    generated_answer=answer.strip() or "[EMPTY]"), parse
