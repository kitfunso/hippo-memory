"""PersonaMem v2, text, 32k, multiple choice (Jiang et al., arXiv 2512.06688).

Authors' repository bowen-upenn/PersonaMem-v2 at d29d91d016add354e459dfeb0d24af08bc402e2a (`inference.py`); data HF
bowen-upenn/PersonaMem-v2 at ed956dea41521fc4499acbc63f966e0fd3c053ba (CC BY 4.0): `benchmark/text/benchmark.csv`
(5,000 questions, 200 personas, 25 each) and the 200 `data/chat_history_32k/*.json` it links, under
~/hippo-bench/datasets/personamem_v2/. The authors give the model the whole chat history, then the user query, then the MCQ
instruction as a system message (inference.py:257,294) and score by match (inference.py:338-379). They set no retrieval
top-k, so TOPK is 20 (prereg). Their MCQ accuracy is the main score (inference.py:409); the open-ended narrow judge
(inference.py:714) needs open-ended replies and is not run.
"""
from __future__ import annotations

import argparse
import ast
import csv
import hashlib
import json
import random
import re
import sys
from pathlib import Path

NAME = "PersonaMem v2 (text, 32k)"
TOPK = 20
LICENCE = "CC BY 4.0 (Hugging Face bowen-upenn/PersonaMem-v2)"
DATA = Path.home() / "hippo-bench" / "datasets" / "personamem_v2"
DATA_FILES = [DATA / "benchmark.csv"] + sorted((DATA / "chat_history_32k").glob("*.json"))

RECALL = " Please recall my related preferences from our conversation history to give personalized responses."


def _rows() -> list[dict]:
    csv.field_size_limit(10 ** 9)
    with (DATA / "benchmark.csv").open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def _query(row: dict) -> str:
    try:
        d = json.loads(row["user_query"])
    except ValueError:
        d = ast.literal_eval(row["user_query"])
    return d["content"]


def _history(link: str) -> list[dict]:
    d = json.loads((DATA / "chat_history_32k" / Path(link).name).read_text(encoding="utf-8"))
    lists = [v for v in d.values() if isinstance(v, list)]
    if len(lists) != 1:
        raise ValueError(f"{link}: {len(lists)} message lists")
    return lists[0]


def conversations():
    seen = set()
    for r in _rows():
        link = r["chat_history_32k_link"]
        if link in seen:
            continue
        seen.add(link)
        yield f"persona{r['persona_id']}", [{"role": m["role"], "content": m["content"], "timestamp": None}
                                           for m in _history(link)]


def _options(row: dict) -> tuple[str, dict]:
    seed = int(hashlib.sha256(f"{row['persona_id']}_{_query(row)}{RECALL}".encode("utf-8")).hexdigest()[:8], 16)
    options = [row["correct_answer"]] + json.loads(row["incorrect_answers"])
    random.Random(seed).shuffle(options)
    mapping = {chr(65 + i): o for i, o in enumerate(options)}
    instruction = ("Please choose the best answer from the following options:\n\n"
                   + "\n".join(f"{k}. {v}" for k, v in mapping.items())
                   + "\n\nThink step by step about which answer best fits the user's query and conversation context. "
                   "Provide your reasoning first, then give your final answer as 'Final Answer: [Letter]'")
    return instruction, mapping


def questions() -> list[dict]:
    out = []
    for i, r in enumerate(_rows()):
        instruction, mapping = _options(r)
        out.append({"qid": f"pm2-{i:04d}", "user_id": f"persona{r['persona_id']}", "question": _query(r),
                    "gold": r["correct_answer"], "category": r["pref_type"], "mcq": instruction, "options": mapping,
                    "ask_after": None})
    return out


def answer_prompt(q: dict, memories: list[dict]) -> tuple[str, str]:
    mems = "\n\n".join(f"[{i}] {m['memory']}" for i, m in enumerate(memories, 1)) or "(none)"
    return q["mcq"], ("Memories retrieved from your earlier conversation with this user, best match first:\n\n" + mems
                      + "\n\nThe user now writes:\n\n" + q["question"] + RECALL)


def extract_final_answer(response: str) -> str:
    if not response:
        return ""
    patterns = [
        r'\$\\boxed\{([A-Z])\}\$',
        r'\\boxed\{([A-Z])\}',
        r'Final Answer:\s*([A-Z])',
        r'final answer:\s*([A-Z])',
        r'Answer:\s*([A-Z])',
        r'answer:\s*([A-Z])',
        r'final answer is\s*\$?\\boxed\{([A-Z])\}\$?',
        r'final answer is\s*([A-Z])',
        r'the answer is\s*\$?\\boxed\{([A-Z])\}\$?',
        r'the answer is\s*([A-Z])',
        r'\b([A-Z])\.\s*$',
    ]
    for pattern in patterns:
        match = re.search(pattern, response, re.IGNORECASE | re.MULTILINE)
        if match:
            return match.group(1).upper()
    return ""


def check_mcq_correctness(predicted: str, correct: str, mapping: dict) -> bool:
    if not predicted or not mapping:
        return False
    return mapping.get(predicted.upper(), "") == correct


def judge(q: dict, answer: str):
    return "match", check_mcq_correctness(extract_final_answer(answer), q["gold"], q["options"])


def score(out: Path, bonferroni: int | None = None) -> str:
    sys.path[:0] = [str(Path(__file__).resolve().parents[1])]
    import harness  # noqa: E402  (imported here: harness imports this module while it runs)

    a = argparse.Namespace(stage="score", bench="personamem_v2", out=out, limit=0, slots=1, port_base=0)
    mod, qs = harness.setup(a)
    answers = harness.all_answers(a, mod, qs)
    ok = {(arm, q["qid"]): 0.0 if (ans := answers[(arm, q["qid"])]["answer"]) is None else float(mod.judge(q, ans)[1])
          for q in qs for arm in harness.ARMS}
    ids, persona = [q["qid"] for q in qs], {q["qid"]: q["user_id"] for q in qs}
    primary, note = harness.primary_ids(a, mod, ids)
    lines = [f"{NAME}: {len(qs)} questions over {len(set(persona.values()))} personas, {len(primary)} in the primary, "
             f"top {TOPK}, MCQ match"]
    for arm in harness.ARMS:
        lines.append(f"{arm:>9}  accuracy {100 * sum(ok[(arm, i)] for i in primary) / len(primary):5.1f}")
    diff = {i: ok[("hippo365", i)] - ok[("bm25", i)] for i in ids}
    lines += harness.primary_lines("hippo365 - bm25, personas", diff, primary, ids, persona.get, bonferroni)
    lines += ["", note, *harness.exhausted_lines({k: r["choice"] for k, r in answers.items()}, "answers")]
    text = "\n".join(lines)
    (out / "score_persona.txt").write_text(text + "\n", encoding="utf-8")
    return text


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cmd", choices=("score",))
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--bonferroni", type=int, metavar="K", help="also the primary's interval at 1 - 0.05/K")
    args = ap.parse_args()
    if args.bonferroni is not None and args.bonferroni < 1:
        ap.error("--bonferroni K needs K of 1 or more")
    print(score(args.out, args.bonferroni))
