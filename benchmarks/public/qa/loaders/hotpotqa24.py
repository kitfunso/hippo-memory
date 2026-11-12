"""Cognee's HotPotQA-24: 24 hard HotpotQA questions over a shared 240-paragraph corpus, one memory store.

Authors' repository topoteretes/cognee at 8853378eae5366addb064e758e560a456146ae1a, `evals/old/hotpot_qa_24_2025/`.
Data `src/hotpot_qa_24_corpus.json` (240 paragraphs) and `src/hotpot_qa_24_qa_pairs.json` (24 questions), copied to
~/hippo-bench/datasets/hotpotqa24/. Every system ingests the whole corpus (qa_benchmark_base.py:83-88). The authors' top-k
differs by system: Cognee's Modal runs use 15 (modal_apps/modal_qa_benchmark_cognee.py:74; the class default is 5,
qa_benchmark_cognee.py:37), Mem0 5 (qa_benchmark_mem0.py:65), Graphiti 10 (qa_benchmark_graphiti.py:110). TOPK is 15, the
benchmark owner's own setting.
Main score: F1 (exact match secondary), run locally by `python -I loaders/hotpotqa24.py score --out DIR [--bonferroni K]`
(no model call), on the answers the call log settles (qa/ledger.py).
Secondary, through the harness judge stage: cognee's own non-DeepEval correctness judge (DirectLLM), which stands in for
DeepEval's GEval, since DeepEval needs a paid key. The harness' own "PRIMARY" score line is that judge, not the main score.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

NAME = "HotPotQA-24 (Cognee)"
TOPK = 15
LICENCE = "Cognee repository Apache-2.0; HotpotQA data CC BY-SA 4.0"
DATA = Path.home() / "hippo-bench" / "datasets" / "hotpotqa24"
DATA_FILES = [DATA / "hotpot_qa_24_corpus.json", DATA / "hotpot_qa_24_qa_pairs.json"]
USER = "hotpot24"
ROLE = "document"  # the server stores "role: content"; answer_prompt drops this prefix again
PREFIX = re.compile(r"^document: ")

# cognee/infrastructure/llm/prompts/answer_simple_question_benchmark2.txt:1-7, verbatim (CRLF to LF). It is the system
# prompt of the authors' Cognee run (qa_benchmark_cognee.py:38); the other systems' prompts (qa_benchmark_mem0.py:72,
# qa_benchmark_graphiti.py:117) differ, and every arm here gets this one.
SYSTEM = ("You are a benchmark-optimized QA system. Provide only essential answers extracted from the context:\n"
          "- Use as few words as possible.\n"
          '- For yes/no questions: answer with "yes" or "no".\n'
          "- For what/who/where questions: reply with a single word or brief phrase.\n"
          "- For when questions: return only the relevant date/time.\n"
          "- For how/why questions: use the briefest phrase.\n"
          "No punctuation, lowercase answers only.")
# cognee/infrastructure/llm/prompts/context_for_question.txt:1-2, the user template of CompletionRetriever
# (modules/retrieval/completion_retriever.py:102); the passages are joined with "\n" (utils/conflict_context.py:188).
USER_TEMPLATE = "The question is: `{question}`\nAnd here is the context: `{context}`"

# cognee/infrastructure/llm/prompts/direct_llm_eval_system.txt:1-10, verbatim ("•\t" starts lines 2-6).
DIRECT_SYSTEM = ("You are helping a reasonable person evaluate and score answers\n"
                 "•\tCompare the provided answer to the golden answer based on common-sense meaning and understanding.\n"
                 "•\tFocus on the meaning, not the exact wording or structure.\n"
                 "•\tIf the answer is correct, don't penalize it for being too short or too long.\n"
                 "•\tExtra details are fine as long as the correct answer is included.\n"
                 "•\tScore should be between 0 and 1.\n"
                 "\n"
                 "Provide:\n"
                 "1. A numerical score\n"
                 "2. A brief explanation justifying the score")
# direct_llm_eval_prompt.txt:1-3, with the Jinja fields filled
DIRECT_USER = "Question: {question}\nProvided Answer: {answer}\nGolden Answer: {golden_answer}"
# The authors get {score, explanation} as structured output (direct_llm_eval_adapter.py:117-121,139-145); the codex judge
# is a JSON-only function, so the same two fields are asked for in the prompt. This sentence is ours.
JSON_FORMAT = ('\n\nReply with only a JSON object {"score": <number from 0 to 1>, "explanation": "<brief explanation>"}.')
FENCE = re.compile(r"^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$")
CORRECT_AT = 0.5  # ours: the authors keep the 0-1 score; the harness takes a verdict, so a score of 0.5 or more is correct


def _json(name: str) -> list:
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def conversations():
    """One user holds all 240 paragraphs, ingested in file order as the authors do (qa_benchmark_base.py:86-87)."""
    yield USER, [{"role": ROLE, "content": p, "timestamp": None} for p in _json("hotpot_qa_24_corpus.json")]


def questions() -> list[dict]:
    """The 24 pairs in file order; all are level "hard" and the answers are lowercase in the data."""
    return [{"qid": f"hotpot24-{i:02d}", "user_id": USER, "question": p["question"], "gold": p["answer"],
             "category": "hotpotqa", "ask_after": None} for i, p in enumerate(_json("hotpot_qa_24_qa_pairs.json"))]


def answer_prompt(q: dict, memories: list[dict]) -> tuple[str, str]:
    context = "\n".join(PREFIX.sub("", m["memory"], count=1) for m in memories)
    return SYSTEM, USER_TEMPLATE.format(question=q["question"], context=context)


def exact_match(answer: str, gold: str) -> float:
    """cognee/eval_framework/evaluation/metrics/exact_match.py:10-12, verbatim."""
    actual = answer.strip().lower() if answer else ""
    expected = gold.strip().lower() if gold else ""
    return 1.0 if actual == expected else 0.0


def _tokens(text: str) -> list[str]:
    return [re.sub(r"\W+", "", t.strip()) for t in text.split() if re.sub(r"\W+", "", t.strip())]


def f1(answer: str, gold: str) -> float:
    """cognee/eval_framework/evaluation/metrics/f1.py:27-59, verbatim apart from returning the score alone."""
    actual_tokens, expected_tokens = _tokens((answer or "").lower()), _tokens((gold or "").lower())
    if not actual_tokens and not expected_tokens:
        return 1.0
    actual_counts, expected_counts = Counter(actual_tokens), Counter(expected_tokens)
    tp = sum(min(actual_counts[w], expected_counts[w]) for w in actual_counts)
    fp = sum(actual_counts[w] for w in actual_counts) - tp
    fn = sum(expected_counts[w] for w in expected_counts) - tp
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    return 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0


def parse(reply: str) -> bool | None:
    """The JSON object's score as correct (0.5 or more) or wrong; None when there is no score between 0 and 1."""
    t = reply.strip()
    fence = FENCE.match(t)
    try:
        v = json.loads(fence[1] if fence else t)
    except ValueError:
        return None
    s = v.get("score") if isinstance(v, dict) else None
    if isinstance(s, bool) or not isinstance(s, (int, float)) or not 0 <= s <= 1:
        return None
    return s >= CORRECT_AT


def judge(q: dict, answer: str):
    """The secondary score: cognee's DirectLLM correctness prompt, run by the codex judge."""
    return ("llm", DIRECT_SYSTEM + JSON_FORMAT,
            DIRECT_USER.format(question=q["question"], answer=answer, golden_answer=q["gold"]), parse)


def _harness():
    """qa/harness.py, imported at call time: harness imports this module while it runs."""
    sys.path[:0] = [str(Path(__file__).resolve().parents[1])]
    import harness  # noqa: E402

    return harness


def match_scores(out: Path, arm: str | None = None, pairs_with: tuple[Path, ...] = ()):
    """(the run's namespace, ids, primary ids, smoke note, answers, {(arm, qid): (EM, F1)}) from the call log; an
    exhausted answer scores 0 on both."""
    harness = _harness()

    a = argparse.Namespace(stage="score", bench="hotpotqa24", out=out, limit=0, slots=1, port_base=0, arm=arm,
                           pairs_with=list(pairs_with))
    mod, qs = harness.setup(a)
    answers = harness.all_answers(a, mod, qs)
    ids, by_id = [q["qid"] for q in qs], {q["qid"]: q for q in qs}
    sc = {(arm_, i): (0.0, 0.0) if (ans := answers[(arm_, i)]["answer"]) is None else
          (exact_match(ans, by_id[i]["gold"]), f1(ans, by_id[i]["gold"])) for arm_ in a.arms for i in ids}
    primary, note = harness.primary_ids(a, mod, ids)
    return a, ids, primary, note, answers, sc


def score(out: Path, bonferroni: int | None = None, arm: str | None = None, pairs_with: tuple[Path, ...] = ()) -> str:
    """F1 and exact match per arm and hippo365 minus bm25. With an extra arm (dated notes 5): its F1 and EM, then the
    arm minus each arm of each paired run, re-made from that run's call log. Smoke items stay out of the primary."""
    harness = _harness()

    a, ids, primary, note, answers, sc = match_scores(out, arm, pairs_with)
    lines = [f"{NAME}: {len(ids)} questions, {len(primary)} in the primary, top {TOPK}, main score F1, exact match "
             f"secondary (cognee metrics, no model call); unit the question: one store holds all 24"]
    for arm_ in a.arms:
        lines.append(f"{arm_:>9}  EM {100 * sum(sc[(arm_, i)][0] for i in primary) / len(primary):5.1f}  "
                     f"F1 {100 * sum(sc[(arm_, i)][1] for i in primary) / len(primary):5.1f}")
    if arm:
        for run in pairs_with:
            r, r_ids, _, _, _, rsc = match_scores(run)
            if r_ids != ids:
                sys.exit(f"{run} holds another question set than {out}")
            for other in r.arms:
                for k, name in ((1, "F1"), (0, "EM")):
                    acc = 100 * sum(rsc[(other, i)][k] for i in primary) / len(primary)
                    diff = {i: sc[(arm, i)][k] - rsc[(other, i)][k] for i in ids}
                    lines.append(f"secondary {arm} - {other} ({acc:.1f} in {run.name}) {name}: "
                                 f"{harness.paired(diff, primary, str)}")
    else:
        diff = [{i: sc[("hippo365", i)][k] - sc[("bm25", i)][k] for i in ids} for k in (0, 1)]
        lines += harness.primary_lines("hippo365 - bm25 F1", diff[1], primary, ids, str, bonferroni)
        lines.append(f"secondary hippo365 - bm25 EM: {harness.paired(diff[0], primary, str)}")
    lines += ["", note, *harness.exhausted_lines({k: r["choice"] for k, r in answers.items()}, "answers")]
    (out / "score_match.jsonl").write_text("".join(json.dumps({"arm": a_, "qid": i, "em": e, "f1": f}) + "\n"
                                                   for (a_, i), (e, f) in sc.items()), encoding="utf-8")
    text = "\n".join(lines)
    (out / "score_match.txt").write_text(text + "\n", encoding="utf-8")
    return text


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cmd", choices=("score",))
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--bonferroni", type=int, metavar="K", help="also the primary's interval at 1 - 0.05/K")
    ap.add_argument("--arm", choices=("hippo-emb",), help="dated notes 5: the extra arm's run in --out")
    ap.add_argument("--pairs-with", type=Path, nargs="+", default=[], metavar="RUN", help="registered runs it pairs with")
    args = ap.parse_args()
    if bool(args.arm) != bool(args.pairs_with):
        ap.error("--arm and --pairs-with go together")
    if args.bonferroni is not None and args.bonferroni < 1:
        ap.error("--bonferroni K needs K of 1 or more")
    print(score(args.out, args.bonferroni, args.arm, tuple(args.pairs_with)))
