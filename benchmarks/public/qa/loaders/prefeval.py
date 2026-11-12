"""PrefEval, explicit preferences with 10 inter-turn filler turns (Zhao et al., arXiv 2502.09597).

Authors' repository amazon-science/PrefEval at 50795054b5ff5f418d2b768a331d71e480f93331; data HF siyanzhao/prefeval_explicit
at 1b20e0f944d7665f435e24eb8b76f4d45d83c419 (1,000 rows over 20 topics, CC BY-NC 4.0 per the repository's LICENSE; the card
sets none). Files under ~/hippo-bench/datasets/prefeval/: hf_train.parquet, prefeval_explicit.jsonl (the parquet's rows, in
order, made by `python -I prefeval.py prepare`), repo/ (the clone), acks.jsonl (made by `python -I prefeval.py acks`).
The authors' history is [user: preference, assistant: the model's reply to it, 10 filler turns of an LMSYS chat, user: the
question] (benchmark_generation.py:112-118, explicit_utils.py:get_question_prompt_rag); their RAG baseline puts the 5 top
exchanges before the question (benchmark_generation.py:59, default topk 5) and so TOPK is 5 here. Each question has its own
22-turn store, so ingestion is per question and every store holds the same 20 filler messages.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

NAME = "PrefEval (explicit, 10 inter-turns)"
TOPK = 5
LICENCE = "CC BY-NC 4.0 (amazon-science/PrefEval LICENSE; Hugging Face siyanzhao/prefeval_explicit sets none)"
DATA = Path.home() / "hippo-bench" / "datasets" / "prefeval"
ROWS = DATA / "prefeval_explicit.jsonl"
FILLER = DATA / "repo" / "benchmark_dataset" / "filtered_inter_turns.json"
ACKS = Path(os.environ.get("PREFEVAL_ACKS") or DATA / "acks.jsonl")  # a smoke run points this into the smoke folder
DATA_FILES = [DATA / "hf_train.parquet", ROWS, FILLER, ACKS]
INTER_TURNS = 10  # run_and_eval_explicit.sh uses 2 and benchmark_generation.py:57 defaults to 5; the prereg fixes 10
MAX_WORDS = 300  # config.yaml:1 max_gen_tokens, written into the question as "words" (explicit_utils.py:401)
MAX_ACK_TOKENS = 300  # config.yaml:1, also the cap on the reply to the preference (common_utils.py:generate_message)

# config.yaml:3
SYSTEM = "You are a helpful assistant."

# explicit_utils.py:369-385, the RAG baseline's wrapper around the retrieved exchanges, verbatim
CONTEXT_HEAD = (
    "Before answering my question, please consider the following context from our previous conversations. "
    "These are the 5 most relevant exchanges that we had previously, which may contain information about "
    "my preferences or prior discussions related to my query:\n\n"
    "#Start of Context#\n"
)
CONTEXT_TAIL = (
    "#End of Context#\n\n"
    "Please use this context to inform your answer and adhere to any preferences I've expressed "
    "that are relevant to the current query. Note that not all contexts are useful for answering "
    "my question and there may be no context that is useful. Now, please address my question:\n\n"
)

# llm_based_evaluation_errortypes.py:164, verbatim (the authors' spelling)
EVAL_SYSTEM = ("You are a helpful assistant in evaluating an AI assistant's reponse. "
               "You should be fair and strict and follow the user's instruction")

# error_type/check_violation.txt, verbatim (the git blob, LF line ends). The authors fill it by str.replace of {preference},
# {question} and {end_generation} (llm_based_evaluation_errortypes.py:188-191).
CHECK_VIOLATION = '''You will analyze a conversation between a user and an assistant, focusing on whether the assistant's response violates the user's stated preference.
Evaluate the response based on these criteria:

Answer "Yes" if:

1. The response contains any recommendations that directly contradict or violate the user's stated preference without any reasoning for why it recommends these contrasting items and no acknowledgment of the user's preference at all.

Answer "No" if:

1. The response respects the user's stated preference.
2. It's acceptable if it includes options that could potentially conflict with the preference, as long as it has acknowledged the user's preference and also specified the reason why or how to avoid the conflict.
3. If the response does not acknowledge the user's preference and if no recommendations violate the user's preference, there is no violation.

Here is the conversation:
User's preference: {preference}
User query: {question}
Assistant response: {end_generation}

Examine the response meticulously and answer. Answer in this exact XML format:
<explanation>[1 very short sentence explanation]</explanation>
<answer>[Yes/No]</answer>'''

# error_type/check_helpful.txt, verbatim, filled the same way (llm_based_evaluation_errortypes.py:188-191).
CHECK_HELPFUL = '''You will analyze a conversation between a user and an assistant, focusing on whether the assistant provides any substantive response to the user's query.
Evaluate the response based on these stringent criteria:

Answer "Yes" if any of the following:

1. The response provides specific, relevant recommendations or advice related to the user's query without any apologetic statements or claims of inability to respond.
2. It remembers the user's preference and provides recommendations or suggestions to the user's query without any apologetic statements or claims of inability to respond.

Answer "No" if any of the following:

1. The response contains apologetic statements or claims of inability to respond due to lack of memory of the user's preference.
2. The assistant asks for more information without providing any substantive suggestions, advices directly related to the query.
3. The response doesn't address the user's query.
4. Even if the agent provides some relevant recommendations, if the agent first expresses an inability to follow the user's preference, answer 'No'.

Examples of unhelpful responses: (Answer: No):

"Unfortunately, I don't actually have enough context about your specific preferences for xxx"
"Unfortunately, we haven't had a previous discussion about your preferences for xxx. Could you let me know your preference for xxx?"
"I apologize, but I don't have access to your personal information or previous conversations."
"I'm sorry, but I can't provide a specific answer without more details."

Here is the conversation:
User query: {question}
Assistant response: {end_generation}

Examine the response meticulously and answer. Answer in this exact XML format:
<explanation>[1 very short sentence explanation]</explanation>
<answer>[Yes/No]</answer>'''

# The one format change: the judge here answers in one JSON object (codex_judge.PREAMBLE), so both checks go in one call and
# each check's XML reply format becomes two fields. The authors run the two checks as separate calls.
JUDGE_SYSTEM = (EVAL_SYSTEM + "\n\nYou are given two independent checks of one assistant response. Do each as its own "
                "task, and let neither answer change the other. Each check ends with an XML reply format; do not use it. "
                'Reply with one JSON object instead: {"violate_explanation": "<the first check\'s explanation>", '
                '"violate": "Yes" or "No", "helpful_explanation": "<the second check\'s explanation>", '
                '"helpful": "Yes" or "No"}, and write nothing outside that object.')
FENCE = re.compile(r"```[a-zA-Z0-9]*\n([\s\S]*?)\n```")  # a whole-reply code fence


def _rows() -> list[dict]:
    with ROWS.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f]


def _ids() -> list[tuple[str, dict]]:
    """(qid, row) in the dataset's order; the index counts within the topic, as the authors' per-topic files do."""
    seen: dict[str, int] = {}
    out = []
    for r in _rows():
        i = seen[r["topic"]] = seen.get(r["topic"], -1) + 1
        out.append((f"{r['topic']}-{i:03d}", r))
    return out


def _filler() -> list[dict]:
    """The first 2 * INTER_TURNS messages of the filler conversations in file order (common_utils.py:54-62, :11-39)."""
    with FILLER.open(encoding="utf-8") as f:
        msgs = [m for t in json.load(f) for m in t["conversation"]][:2 * INTER_TURNS]
    if len(msgs) != 2 * INTER_TURNS or msgs[-1]["role"] != "assistant":
        sys.exit(f"{FILLER}: the first {2 * INTER_TURNS} messages are not {INTER_TURNS} whole turns")
    return [{"role": m["role"], "content": m["content"]} for m in msgs]


def _acks() -> dict[str, str]:
    out: dict[str, str] = {}
    if ACKS.exists():
        with ACKS.open(encoding="utf-8") as f:
            for line in f:
                r = json.loads(line)
                out[r["qid"]] = r["text"]
    return out


def conversations():
    """Per question: the user states the preference, the assistant replies (acks.jsonl), then the filler turns. The data
    holds no dates, so no timestamps. A question with no reply yet is skipped, and the harness then names it."""
    acks, filler, missing = _acks(), _filler(), 0
    for qid, r in _ids():
        if qid not in acks:
            missing += 1
            continue
        turns = [{"role": "user", "content": r["preference"]}, {"role": "assistant", "content": acks[qid]}] + filler
        yield qid, [{**t, "timestamp": None} for t in turns]
    if missing:
        print(f"prefeval: {missing} questions have no reply to their preference in {ACKS}; run "
              "`python -I loaders/prefeval.py acks`", file=sys.stderr)


def questions() -> list[dict]:
    """One question per row, asked after all 22 turns. gold is the preference, which the judge is given."""
    if not ACKS.exists():
        sys.exit(f"{ACKS} is missing; run `python -I loaders/prefeval.py acks` first (add --limit 5 for a smoke)")
    return [{"qid": qid, "user_id": qid, "question": r["question"], "gold": r["preference"], "category": r["topic"],
             "ask_after": None} for qid, r in _ids()]


def answer_prompt(q: dict, memories: list[dict]) -> tuple[str, str]:
    """The RAG baseline's user message (explicit_utils.py:388-401): the wrapper, the retrieved exchanges numbered from 1
    as "exchange N. user: ..." (baselines_handling.py:86-90; msg_index_*.json holds "user: ..." lines, as the server
    stores them), the question, and the length request. The authors also send the whole history as messages; the
    memories stand in for it, as in the other loaders."""
    ctx = "".join(f"exchange {i}. {m['memory']}\n" for i, m in enumerate(memories, 1))
    return SYSTEM, CONTEXT_HEAD + ctx + CONTEXT_TAIL + q["question"] + f" (Please respond within {MAX_WORDS} words.)"


def _yes_no(v: object) -> bool | None:
    return {"yes": True, "no": False}.get(re.sub(r"[^a-z]", "", str(v).lower()))


def parse(reply: str) -> bool | None:
    """True if the response follows the preference. get_preference_following_accuracy_generation_task.py:69-82 reduces to
    not violated and not unhelpful: its three violation error types cover every acknowledged, hallucinated or unaware
    case, so acknowledgement and hallucination do not change the score. Violated is "yes" in the check_violation answer
    (:71), unhelpful is "no" in the check_helpful answer (:72). None if a reply gives no Yes or No for either check."""
    t = reply.strip()
    fence = FENCE.fullmatch(t)
    try:
        v = json.loads(fence[1] if fence else t)
    except ValueError:
        return None
    if not isinstance(v, dict):
        return None
    violate, helpful = _yes_no(v.get("violate")), _yes_no(v.get("helpful"))
    if violate is None or helpful is None:
        return None
    return not violate and helpful


def judge(q: dict, answer: str):
    def fill(t: str) -> str:
        return t.replace("{preference}", q["gold"]).replace("{question}", q["question"]).replace("{end_generation}", answer)
    prompt = "Check 1 of 2\n\n" + fill(CHECK_VIOLATION) + "\n\n----\n\nCheck 2 of 2\n\n" + fill(CHECK_HELPFUL)
    return "llm", JUDGE_SYSTEM, prompt, parse


def _truncate(text: str) -> str:
    """The authors cap the reply to the preference at max_tokens 300 (config.yaml:1); claude -p has no cap, so the reply
    is cut after its first 225 words (300 tokens at 0.75 words a token), at a word end."""
    words = list(re.finditer(r"\S+", text))
    cap = round(MAX_ACK_TOKENS * 0.75)
    return text if len(words) <= cap else text[:words[cap - 1].end()]


def prepare() -> None:
    import pandas as pd  # only here: the loader itself reads the jsonl
    df = pd.read_parquet(DATA / "hf_train.parquet")
    with ROWS.open("w", encoding="utf-8", newline="\n") as f:
        for r in df.to_dict("records"):
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"{len(df)} rows written to {ROWS}")


def acks(limit: int, slots: int) -> None:
    """The assistant's reply to each preference: Claude Sonnet 5 at medium effort, the answerer, with the authors' system
    prompt and the preference as the only message (benchmark_generation.py:113-118). Appends to ACKS; a question already in
    it is not asked again. --limit N takes the questions the harness's smoke takes (harness.py setup: every len//N-th)."""
    from concurrent.futures import ThreadPoolExecutor
    here = Path(__file__).resolve()
    sys.path[:0] = [str(here.parents[2]), str(here.parents[2] / "mem0")]
    from claude_llm import Claude
    ids = _ids()
    if limit:
        ids = ids[::max(1, len(ids) // limit)][:limit]
    have = _acks()
    todo = [(qid, r) for qid, r in ids if qid not in have]
    ACKS.parent.mkdir(parents=True, exist_ok=True)
    claude = Claude(ACKS.parent / "claude-acks", ACKS.with_name(ACKS.stem + "-calls.jsonl"), slots)

    def one(item: tuple) -> dict:
        qid, r = item
        text = claude.ask(SYSTEM, r["preference"], effort="medium", tag=f"ack {qid}")["text"]
        return {"qid": qid, "preference": r["preference"], "reply": text, "text": _truncate(text)}

    print(f"{len(todo)} replies to make, {len(have)} already in {ACKS}", flush=True)
    with ThreadPoolExecutor(slots) as pool, ACKS.open("a", encoding="utf-8", newline="\n") as f:
        for rec in pool.map(one, todo):
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            f.flush()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cmd", choices=("prepare", "acks"))
    ap.add_argument("--limit", type=int, default=0, help="acks: only the questions a smoke of this size takes")
    ap.add_argument("--slots", type=int, default=10)
    a = ap.parse_args()
    prepare() if a.cmd == "prepare" else acks(a.limit, a.slots)
