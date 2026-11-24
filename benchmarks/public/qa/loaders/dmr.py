from __future__ import annotations

import json
import re
from pathlib import Path

NAME = "DMR (MSC-Self-Instruct)"
TOPK = 20
LICENCE = "Apache-2.0 (Hugging Face MemGPT/MSC-Self-Instruct)"
DATA = Path.home() / "hippo-bench" / "datasets" / "dmr" / "msc_self_instruct.jsonl"
DATA_FILES = [DATA]

T0 = 1696118400
GAP = re.compile(r"(?:(\d+)\s*days?)?\s*(?:(\d+)\s*hours?)?\s*ago")

SYSTEM = ("Your task is to answer a question from the user about your prior conversations.\n"
          "The following are excerpts retrieved from all your prior conversations, best match first:\n"
          "{memories}\n"
          "If you do not have enough information to answer the question, reply 'NO ANSWER'. Either reply with the "
          "answer, or reply 'NO ANSWER', do not say anything else.")

JUDGE = (
    "Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given the following data: "
    "(1) a question (posed by one user to another user), (2) a 'gold' (ground truth) answer, (3) a generated answer "
    "which you will score as CORRECT/WRONG.\n\n"
    "The point of the question is to ask about something one user should know about the other user based on their "
    "prior conversations.\n"
    "The gold answer will usually be a concise and short answer that includes the referenced topic, for example:\n"
    "Question: Do you remember what I got the last time I went to Hawaii?\n"
    "Gold answer: A shell necklace\n"
    "The generated answer might be much longer, but you should be generous with your grading - as long as it touches "
    "on the same topic as the gold answer, it should be counted as CORRECT.\n\n"
    "For example, the following answers would be considered CORRECT:\n"
    "Generated answer (CORRECT): Oh yeah, that was so fun! I got so much stuff there, including that shell necklace.\n"
    "Generated answer (CORRECT): I got a ton of stuff... that surfboard, the mug, the necklace, those coasters too..\n"
    "Generated answer (CORRECT): That cute necklace\n\n"
    "The following answers would be considered WRONG:\n"
    "Generated answer (WRONG): Oh yeah, that was so fun! I got so much stuff there, including that mug.\n"
    "Generated answer (WRONG): I got a ton of stuff... that surfboard, the mug, those coasters too..\n"
    "Generated answer (WRONG): I’m sorry, I don’t remember what you’re talking about.\n\n"
    "Now it’s time for the real question:\n"
    "Question: {question}\n"
    "Gold answer: {gold}\n"
    "Generated answer: {answer}\n\n"
    "First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG. Do NOT "
    "include both CORRECT and WRONG in your response, or it will break the evaluation script.")
LABEL = re.compile(r"\b(CORRECT|WRONG)\b")
FENCE = re.compile(r"```[a-zA-Z0-9]*\n([\s\S]*?)\n```")

def _rows() -> list[dict]:
    with DATA.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f]


def _ago(text: str) -> int:
    m = GAP.fullmatch(text.strip())
    if not m or not any(m.groups()):
        raise ValueError(f"unreadable time_back {text!r}")
    return int(m[1] or 0) * 86400 + int(m[2] or 0) * 3600


def conversations():
    for i, r in enumerate(_rows()):
        sessions = [(T0 - _ago(p["time_back"]), p["dialog"]) for p in r["previous_dialogs"]] + [(T0, r["dialog"])]
        turns = [{"role": f"Speaker {1 + j % 2}", "content": d["text"], "timestamp": float(start + j)}
                 for start, dialog in sessions for j, d in enumerate(dialog)]
        yield f"dmr-{i:03d}", turns


def questions() -> list[dict]:
    return [{"qid": f"dmr-{i:03d}", "user_id": f"dmr-{i:03d}", "question": r["self_instruct"]["B"],
             "gold": r["self_instruct"]["A"], "category": "dmr", "ask_after": None, "source_id": r["metadata"]["initial_data_id"]}
            for i, r in enumerate(_rows())]


def answer_prompt(q: dict, memories: list[dict]) -> tuple[str, str]:
    mems = "\n".join(f"- {m['memory']}" for m in memories) or "(none)"
    return SYSTEM.format(memories=mems), q["question"]


def parse(reply: str) -> bool | None:
    t = reply.strip()
    fence = FENCE.fullmatch(t)
    try:
        v = json.loads(fence[1] if fence else t)
    except ValueError:
        v = None
    if isinstance(v, dict) and str(v.get("label", "")).upper() in ("CORRECT", "WRONG"):
        return str(v["label"]).upper() == "CORRECT"
    labels = set(LABEL.findall(reply))
    return {"CORRECT": True, "WRONG": False}[labels.pop()] if len(labels) == 1 else None


JUDGE_SYSTEM = ('Put your one-sentence explanation in "reasoning" and your verdict in "label", as '
                '{"reasoning": "<one sentence>", "label": "CORRECT"} or {"reasoning": "<one sentence>", "label": "WRONG"}, '
                "and write nothing outside that object.")


def judge(q: dict, answer: str):
    return "llm", JUDGE_SYSTEM, JUDGE.format(question=q["question"], gold=q["gold"], answer=answer.strip()), parse
