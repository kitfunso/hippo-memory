"""PersonaMem v1, 32k split, multiple choice (Jiang et al., arXiv 2504.14225).

Authors' repository bowen-upenn/PersonaMem at d07e6ade22e8 (`inference.py`); data HF bowen-upenn/PersonaMem-v1 at
a8076d5608c9 (MIT), `questions_32k.csv` and `shared_contexts_32k.jsonl` under ~/hippo-bench/datasets/personamem/.
The authors give the model the whole shared context cut at end_index_in_shared_context
(inference.py:495,499) and score by match (inference.py:106-136). They set no retrieval top-k, so TOPK is 20 (prereg).
"""
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

# inference.py:56-57, verbatim
INSTRUCTIONS = ("Find the most appropriate model response and give your final answer (a), (b), (c), or (d) after the "
                "special token <final_answer>.")
SPEAKER = re.compile(r"^(User|Assistant): ")  # the data prefixes each turn with its speaker; the memory adds the role


def _contexts() -> dict[str, list[dict]]:
    out = {}
    with (DATA / "shared_contexts_32k.jsonl").open(encoding="utf-8") as f:
        for line in f:
            d = json.loads(line)
            out.update(d)  # one {shared_context_id: messages} per line (inference.py:394-419)
    return out


def _rows() -> list[dict]:
    with (DATA / "questions_32k.csv").open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def conversations():
    """One user per shared context. Turns are the context's messages in order, system messages included (the persona
    block repeats at each session), the "User: " and "Assistant: " prefixes dropped because the memory carries the role.
    The data holds no dates."""
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
            choices = ast.literal_eval(raw)  # 162 of 589 rows are written as a Python list
        out.append({"qid": r["question_id"], "user_id": r["shared_context_id"], "question": r["user_question_or_message"],
                    "gold": r["correct_answer"], "category": r["question_type"], "choices": choices, "options_raw": raw,
                    "ask_after": int(r["end_index_in_shared_context"])})  # context[:end_index] (inference.py:499)
    return out


def answer_prompt(q: dict, memories: list[dict]) -> tuple[str, str]:
    """The authors' last user message verbatim (question, instructions, all_options: inference.py:59), with the
    retrieved memories in place of the shared context they put before it (inference.py:59). The framing lines are ours."""
    mems = "\n\n".join(f"[{i}] {m['memory']}" for i, m in enumerate(memories, 1)) or "(none)"
    final = q["question"] + "\n\n" + INSTRUCTIONS + "\n\n" + q["options_raw"]
    return "", ("Memories retrieved from your earlier conversation with this user, best match first:\n\n" + mems
                + "\n\nThe user now writes:\n\n" + final)


def extract_answer(predicted_answer: str, correct_answer: str) -> bool:
    """inference.py:106-136, verbatim apart from returning the verdict alone."""
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
