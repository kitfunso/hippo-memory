"""LoCoMo as the Mem0 paper ran it, over hippo's registered retrievals (prereg Amendment 6, dated notes 22, lane M).

mem0ai/mem0 aae5989e78 evaluation/: each speaker's top 30 memories as "<timestamp>: <memory>" in ANSWER_PROMPT, sent as
one system message to gpt-4o-mini at temperature 0 (src/memzero/search.py), judged by llm_judge.py's ACCURACY_PROMPT on
gpt-4o-mini, scored as the mean J over all 1,540 category 1 to 4 questions and per category (generate_scores.py).
Here a speaker's 30 are that speaker's first 30 hits in hippo's ranked list. No competitor arm runs (Keith, 13 Nov).
Usage (runner venv): python -I locomo_mem0_paper.py {run,score} --arm {hippo-emb,hippo365,bm25} [--limit N] [--slots 8]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent), str(HERE.parent / "runner")]
import h2h  # noqa: E402
from qa.ledger import Item, Ledger, Manifest, exhausted_lines, one_writer, require, unsettled  # noqa: E402
from qa.mem0_paper_prompts import ANSWER_PROMPT  # noqa: E402
from qa.official_judges import ACCURACY_PROMPT  # noqa: E402
from qa.openai_llm import EFFORT, OpenAIChat, Settings  # noqa: E402
from rescore_official import LOCOMO_JUDGE, label_in  # noqa: E402

ARMS = ("hippo-emb", "hippo365", "bm25")
OUT = Path.home() / "hippo-bench" / "results-r2" / "locomo-mem0-paper"
TOP_K = 30  # per speaker: evaluation/Makefile line 7
ANSWERER = Settings("gpt-4o-mini-2024-07-18", role="system")
HIT = re.compile(r"(?:user|assistant): ([^:\n]+): ")


def manifest(s: Settings) -> Manifest:
    return Manifest(s.model, EFFORT, s.cli)


def locomo_time(created_at: str) -> str:
    """'2023-05-08T13:56:00.000Z' as LoCoMo writes session times: '1:56 pm on 8 May, 2023'."""
    t = dt.datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    return f"{t.hour % 12 or 12}:{t.minute:02d} {'am' if t.hour < 12 else 'pm'} on {t.day} {t.strftime('%B')}, {t.year}"


def by_speaker(hits: list[dict], speakers: tuple[str, str]) -> tuple[list[str], list[str]]:
    """Each speaker's first TOP_K hits in rank order, as search.py formats them; the role word is dropped."""
    out: tuple[list[str], list[str]] = ([], [])
    for h in hits:
        m = HIT.match(h["memory"])
        if not m or m.group(1) not in speakers:
            raise ValueError(f"a hit names no speaker of {speakers}: {h['memory'][:60]!r}")
        side = out[speakers.index(m.group(1))]
        if len(side) < TOP_K:
            side.append(f"{locomo_time(h['created_at'])}: {h['memory'][m.start(1):]}")
    return out


def answer_prompt(question: str, hits: list[dict], speakers: tuple[str, str]) -> str:
    """ANSWER_PROMPT rendered as jinja2 renders it: four plain {{ name }} fields, no filters, no escaping."""
    one, two = by_speaker(hits, speakers)
    fields = {"speaker_1_user_id": speakers[0], "speaker_2_user_id": speakers[1],
              "speaker_1_memories": json.dumps(one, indent=4), "speaker_2_memories": json.dumps(two, indent=4),
              "question": question}
    return re.sub(r"\{\{(\w+)\}\}", lambda m: fields[m.group(1)], ANSWER_PROMPT)


def questions(data: list) -> list[str]:
    return [f"conv{i}_q{j}" for i, c in enumerate(data) for j, q in enumerate(c["qa"]) if q.get("category") in (1, 2, 3, 4)]


def answer_items(arm: str, data: list, qids: list[str]) -> dict[str, Item]:
    items = {}
    for qid in qids:
        conv = data[int(qid.split("_q")[0][4:])]["conversation"]
        q = h2h.predicted(Path("."), arm, qid)
        prompt = answer_prompt(q["question"], q["retrieval"]["search_results"], (conv["speaker_a"], conv["speaker_b"]))
        items[qid] = Item(f"m0paper answer {arm} {qid}", "", prompt, manifest(ANSWERER), lambda t: t.strip() or None)
    return items


def judge_item(arm: str, qid: str, data: list, answer: str) -> Item:
    qa = h2h.qa_of(data, qid)
    prompt = ACCURACY_PROMPT.format(question=qa["question"], gold_answer=qa["answer"], generated_answer=answer)
    return Item(f"m0paper judge {arm} {qid}", "", prompt, manifest(LOCOMO_JUDGE), label_in)


def run(arm: str, out: Path, data: list, qids: list[str], slots: int) -> None:
    """Answers each question, then judges it, each item settled through its own call log."""
    out.mkdir(parents=True, exist_ok=True)
    answers, judges = Ledger(out / "calls-answer.jsonl"), Ledger(out / "calls-judge.jsonl")
    a_llm = OpenAIChat(out / "calls-answer.jsonl", ANSWERER, slots=slots)
    j_llm = OpenAIChat(out / "calls-judge.jsonl", LOCOMO_JUDGE, slots=slots)
    require(a_llm, manifest(ANSWERER))
    require(j_llm, manifest(LOCOMO_JUDGE))
    items = answer_items(arm, data, qids)

    def one(qid: str) -> None:
        a = answers.settle(items[qid], a_llm)
        if a.status == "valid":
            judges.settle(judge_item(arm, qid, data, a.value), j_llm)

    print(f"{arm}: {len(qids)} questions into {out}", flush=True)
    with ThreadPoolExecutor(slots) as pool:
        for i, _ in enumerate(pool.map(one, qids), 1):
            if i % 250 == 0:
                print(f"  {i}/{len(qids)}", flush=True)


def score(arm: str, out: Path, data: list, qids: list[str]) -> None:
    """Mean J over every question and per category; an answer or verdict exhausted in 3 asks scores wrong."""
    answers, judges = Ledger(out / "calls-answer.jsonl"), Ledger(out / "calls-judge.jsonl")
    items = answer_items(arm, data, qids)
    a = {q: answers.choose(items[q]) for q in qids}
    unsettled(a, "answers")
    j = {q: judges.choose(judge_item(arm, q, data, a[q].value)) for q in qids if a[q].status == "valid"}
    unsettled(j, "verdicts")
    right = {q: q in j and j[q].status == "valid" and bool(j[q].value) for q in qids}
    tokens = [(c.record.get("usage") or {}).get("prompt_tokens") or 0 for c in a.values() if c.record]
    lines = [f"LoCoMo as the Mem0 paper ran it, {arm}: {TOP_K} memories per speaker, {ANSWERER.model} answers, "
             f"{LOCOMO_JUDGE.model} judge (mem0ai/mem0 aae5989e78); one run",
             f"J overall {100 * sum(right.values()) / len(qids):5.2f}  n={len(qids)}  "
             f"mean answer prompt tokens {sum(tokens) / max(1, len(tokens)):.0f}"]
    for cat, name in sorted(h2h.CAT.items()):
        ids = [q for q in qids if h2h.qa_of(data, q)["category"] == cat]
        if ids:
            lines.append(f"  {name:>12}  J {100 * sum(right[q] for q in ids) / len(ids):5.2f}  n={len(ids)}")
    lines += exhausted_lines(a, "answers") + exhausted_lines(j, "verdicts")
    (out / "score.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("run", "score"))
    ap.add_argument("--arm", choices=ARMS, required=True)
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--limit", type=int, help="smoke: the first N questions, into OUT/smoke/ARM")
    a = ap.parse_args()
    data = h2h.load(h2h.LOCOMO / "data" / "locomo10.json")
    qids = questions(data)[:a.limit] if a.limit else questions(data)
    out = OUT / "smoke" / a.arm if a.limit else OUT / a.arm
    if a.stage == "score":
        score(a.arm, out, data, qids)
        return
    out.mkdir(parents=True, exist_ok=True)
    with one_writer(out):
        run(a.arm, out, data, qids, a.slots)


if __name__ == "__main__":
    main()
