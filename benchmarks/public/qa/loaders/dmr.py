"""DMR, deep memory retrieval, on MSC-Self-Instruct (Packer et al., MemGPT, arXiv 2310.08560, section 3.1.1).

Data: HF MemGPT/MSC-Self-Instruct at 5138f416f8fa (Apache-2.0), `msc_self_instruct.jsonl`, 500 rows, under
~/hippo-bench/datasets/dmr/. The MemGPT repository (letta-ai/letta, tag 0.4.0) holds no DMR evaluation code: its
`paper_experiments/` has only doc_qa_task and nested_kv_task. The question and judge protocol is therefore the paper's
own appendix (arXiv 2310.08560v2 p.11, 6.1.1 baseline instructions and 6.1.2 LLM judge). The paper sets no top-k, so
TOPK is 20 (prereg). The paper scores with the LLM judge and ROUGE-L recall; only the judge is run here.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

NAME = "DMR (MSC-Self-Instruct)"
TOPK = 20
LICENCE = "Apache-2.0 (Hugging Face MemGPT/MSC-Self-Instruct)"
DATA = Path.home() / "hippo-bench" / "datasets" / "dmr" / "msc_self_instruct.jsonl"
DATA_FILES = [DATA]

T0 = 1696118400  # 2023-10-01 UTC. The data holds only gaps before session 5, so this anchor is ours and only offsets matter.
GAP = re.compile(r"(?:(\d+)\s*days?)?\s*(?:(\d+)\s*hours?)?\s*ago")

# Appendix 6.1.1, "The baselines received the following instructions via a system prompt". Verbatim, line wraps joined.
# The paper's CONVERSATION SUMMARY is the retrieved memories here, and its summary sentence says so. The sentence "Answer
# from the perspective of the persona provided" is left out: the final persona lists name the answer in some rows
# (row 0: "I like Taylor Swift", gold "Taylor Swift!"), so giving one would bypass memory.
SYSTEM = ("Your task is to answer a question from the user about your prior conversations.\n"
          "The following are excerpts retrieved from all your prior conversations, best match first:\n"
          "{memories}\n"
          "If you do not have enough information to answer the question, reply 'NO ANSWER'. Either reply with the "
          "answer, or reply 'NO ANSWER', do not say anything else.")

# Appendix 6.1.2, verbatim, line wraps joined; the paper's QUESTION, GOLD ANSWER and GENERATED ANSWER are filled in.
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
FENCE = re.compile(r"```[a-zA-Z0-9]*\n([\s\S]*?)\n```")  # a whole-reply code fence

def _rows() -> list[dict]:
    with DATA.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f]


def _ago(text: str) -> int:
    m = GAP.fullmatch(text.strip())
    if not m or not any(m.groups()):
        raise ValueError(f"unreadable time_back {text!r}")
    return int(m[1] or 0) * 86400 + int(m[2] or 0) * 3600


def conversations():
    """Sessions 1 to 5 of each row: the four previous_dialogs, then `dialog`. The data names no speaker in the first
    four, so speakers alternate from Speaker 1, as in `dialog`. Session k starts time_back before session 5; a turn
    follows its session's start by its index in seconds, to keep order."""
    for i, r in enumerate(_rows()):
        sessions = [(T0 - _ago(p["time_back"]), p["dialog"]) for p in r["previous_dialogs"]] + [(T0, r["dialog"])]
        turns = [{"role": f"Speaker {1 + j % 2}", "content": d["text"], "timestamp": float(start + j)}
                 for start, dialog in sessions for j, d in enumerate(dialog)]
        yield f"dmr-{i:03d}", turns


def questions() -> list[dict]:
    """One question per row, asked after session 5. `B` asks and `A` is the gold answer; A is Speaker 1: by word
    overlap with the previous sessions 270 rows lean to Speaker 1, 61 to Speaker 2 and 160 tie. A is the answerer."""
    return [{"qid": f"dmr-{i:03d}", "user_id": f"dmr-{i:03d}", "question": r["self_instruct"]["B"],
             "gold": r["self_instruct"]["A"], "category": "dmr", "ask_after": None, "source_id": r["metadata"]["initial_data_id"]}
            for i, r in enumerate(_rows())]


def answer_prompt(q: dict, memories: list[dict]) -> tuple[str, str]:
    mems = "\n".join(f"- {m['memory']}" for m in memories) or "(none)"
    return SYSTEM.format(memories=mems), q["question"]


def parse(reply: str) -> bool | None:
    """The judge runs as a JSON-only function (codex_judge.PREAMBLE), so a JSON label is read first; a plain reply is
    read as the paper's script reads it, one of CORRECT or WRONG and never both."""
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


# The one format change to the paper's prompt: the judge here answers in JSON only, so the explanation sits in a field.
JUDGE_SYSTEM = ('Put your one-sentence explanation in "reasoning" and your verdict in "label", as '
                '{"reasoning": "<one sentence>", "label": "CORRECT"} or {"reasoning": "<one sentence>", "label": "WRONG"}, '
                "and write nothing outside that object.")


def judge(q: dict, answer: str):
    return "llm", JUDGE_SYSTEM, JUDGE.format(question=q["question"], gold=q["gold"], answer=answer.strip()), parse
