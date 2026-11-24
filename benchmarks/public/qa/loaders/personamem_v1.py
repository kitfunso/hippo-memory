from __future__ import annotations

import csv
import json
import ast
import re
from pathlib import Path

NAME = "PersonaMem v1 (32k)"
TOPK = 20
LICENCE = "MIT (Hugging Face bowen-upenn/PersonaMem-v1)"
DATA = Path.home() / "hippo-bench" / "datasets" / "personamem"
DATA_FILES = [DATA / "questions_32k.csv", DATA / "shared_contexts_32k.jsonl"]

INSTRUCTIONS = ("Find the most appropriate model response and give your final answer (a), (b), (c), or (d) after the "
                "special token <final_answer>.")
SPEAKER = re.compile(r"^(User|Assistant): ")


def _contexts() -> dict[str, list[dict]]:
    out = {}
    with (DATA / "shared_contexts_32k.jsonl").open(encoding="utf-8") as f:
        for line in f:
            d = json.loads(line)
            out.update(d)
    return out


def _rows() -> list[dict]:
    with (DATA / "questions_32k.csv").open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def conversations():
    for sid, msgs in _contexts().items():
        yield sid, [{"role": m["role"], "content": SPEAKER.sub("", m["content"], count=1), "timestamp": None}
                    for m in msgs]


def questions() -> list[dict]:
    out = []
    for r in _rows():
        raw = r["all_options"]
        try:
            choices = json.loads(raw)
        except ValueError:
            choices = ast.literal_eval(raw)
        out.append({"qid": r["question_id"], "user_id": r["shared_context_id"], "question": r["user_question_or_message"],
                    "gold": r["correct_answer"], "category": r["question_type"], "choices": choices, "options_raw": raw,
                    "ask_after": int(r["end_index_in_shared_context"])})
    return out


def answer_prompt(q: dict, memories: list[dict]) -> tuple[str, str]:
    mems = "\n\n".join(f"[{i}] {m['memory']}" for i, m in enumerate(memories, 1)) or "(none)"
    final = q["question"] + "\n\n" + INSTRUCTIONS + "\n\n" + q["options_raw"]
    return "", ("Memories retrieved from your earlier conversation with this user, best match first:\n\n" + mems
                + "\n\nThe user now writes:\n\n" + final)


def extract_answer(predicted_answer: str, correct_answer: str) -> bool:
    def _extract_only_options(text):
        text = text.lower()
        in_parens = re.findall(r'\(([a-d])\)', text)
        if in_parens:
            return set(in_parens)
        else:
            return set(re.findall(r'\b([a-d])\b', text))

    correct = correct_answer.lower().strip("() ")
    full_response = predicted_answer
    predicted_answer = predicted_answer.strip()
    if "<final_answer>" in predicted_answer:
        predicted_answer = predicted_answer.split("<final_answer>")[-1].strip()
    if predicted_answer.endswith("</final_answer>"):
        predicted_answer = predicted_answer[:-len("</final_answer>")].strip()
    pred_options = _extract_only_options(predicted_answer)
    if pred_options == {correct}:
        return True
    response_options = _extract_only_options(full_response)
    return response_options == {correct}


def judge(q: dict, answer: str):
    return "match", extract_answer(answer, q["gold"])
