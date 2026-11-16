"""Judge saved answers again with each benchmark's published judge prompt and parse (prereg Amendment 6, dated notes 19).

LongMemEval: evaluate_qa.py's prompt per question type, read as `'yes' in reply.lower()`. LoCoMo: the Mem0 paper's
ACCURACY_PROMPT and its JSON label. The judge stays gpt-5.6-sol at medium through codex; the published runs judged with
gpt-4o (LongMemEval) and gpt-4o-mini (Mem0 paper), the one gap left. No answer is asked again, and no competitor arm
is judged (Keith, 13 Nov). Each item takes the first valid reply in 3 asks (qa/ledger.py).
--judge openai (dated notes 22): the published judge itself, gpt-4o or gpt-4o-mini with the published settings, on
Keith's key, into official-judge-openai/.
Usage (runner venv): python -I rescore_official.py {judge,score} --bench {longmemeval-s,longmemeval-m,locomo} --out RUN_DIR
[--judge {codex,openai}] [--only ARM:CUTOFF ...]: those cells alone, scored into score-ARM-CUTOFF.txt beside score.txt
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent
sys.path[:0] = [str(PUBLIC / "mem0"), str(PUBLIC / "qa"), str(PUBLIC)]
import codex_judge  # noqa: E402
import h2h  # noqa: E402
from qa.ledger import (JUDGE, Item, Ledger, Manifest, exhausted_lines, one_writer, require, smoke_excluded,  # noqa: E402
                       unsettled)
from qa.official_judges import ACCURACY_PROMPT, get_anscheck_prompt  # noqa: E402
from qa.openai_llm import EFFORT, OpenAIChat, Settings  # noqa: E402

# answer_judge.py's preamble (lines 40-43): no tools, the format left to the prompt, so a yes/no judge stays yes/no
PREAMBLE = ("You are a grading function. Do NOT use any tool. Do NOT read, open, view or write any file. "
            "Everything you need is in this message. Reply in exactly the format the instructions ask for.\n\n")
COMPETITORS = {"mem0"}
SUBS = {"codex": "official-judge", "openai": "official-judge-openai"}
NAMES = {"longmemeval-s": "LongMemEval-S", "longmemeval-m": "LongMemEval-M", "locomo": "LoCoMo"}
PUBLISHED_JUDGE = {"longmemeval-s": "gpt-4o", "longmemeval-m": "gpt-4o", "locomo": "gpt-4o-mini"}
# evaluate_qa.py lines 102 to 110: one user message, temperature 0, max_tokens 10. llm_judge.py lines 40 to 53: JSON mode.
LME_JUDGE = Settings("gpt-4o-2024-08-06", max_tokens=10)
LOCOMO_JUDGE = Settings("gpt-4o-mini-2024-07-18", json_object=True)
PUBLISHED = {"longmemeval-s": LME_JUDGE, "longmemeval-m": LME_JUDGE, "locomo": LOCOMO_JUDGE}


def manifest_of(bench: str, judge: str) -> Manifest:
    if judge == "codex":
        return JUDGE
    return Manifest(PUBLISHED[bench].model, EFFORT, PUBLISHED[bench].cli)


def yes_in(text: str) -> bool | None:
    """evaluate_qa.py:113 reads `'yes' in reply.lower()`; a reply with neither yes nor no is asked again."""
    t = text.lower()
    return ("yes" in t) if re.search(r"\b(yes|no)\b", t) else None


def label_in(text: str) -> bool | None:
    """llm_judge.py reads the reply's JSON label, CORRECT as 1; a reply with no CORRECT or WRONG label is asked again."""
    for m in re.finditer(r"\{[^{}]*\}", text):
        try:
            v = json.loads(m.group(0))
        except ValueError:
            continue
        if isinstance(v, dict) and v.get("label") in ("CORRECT", "WRONG"):
            return v["label"] == "CORRECT"
    return None


def lme_items(out: Path, manifest: Manifest = JUDGE) -> dict[tuple[str, str, str], tuple[Item, bool]]:
    """(arm, cutoff, qid) -> the official judge item and the registered verdict, for every saved answer."""
    items = {}
    for rec in h2h.read_jsonl(out / "results.jsonl"):
        r, arm = rec["result"], rec["arm"]
        qid = r["question_id"]
        for cut, v in r["cutoff_results"].items():
            prompt = get_anscheck_prompt(r["question_type"], r["question"], r["ground_truth_answer"], v["generated_answer"],
                                         abstention="_abs" in qid)
            items[(arm, cut, qid)] = (Item(f"official {arm} {cut} {qid}", "", prompt, manifest, yes_in), bool(v["score"]))
    return items


def locomo_items(out: Path, data: list, manifest: Manifest = JUDGE) -> dict[tuple[str, str, str], tuple[Item, bool]]:
    """(arm, cutoff, qid) -> the Mem0-paper judge item and the registered verdict, for every hippo and control answer."""
    key = h2h.load(out / "judge_key.json")
    old = {(key[r["id"]]["arm"], key[r["id"]]["cutoff"], key[r["id"]]["qid"]): r["label"] == "CORRECT"
           for r in h2h.read_jsonl(out / "verdicts.jsonl")}
    items = {}
    for r in h2h.read_jsonl(out / "answers.jsonl"):
        k = (r["arm"], r["cutoff"], r["qid"])
        if r["arm"] in COMPETITORS:
            continue
        if r["answer"] is None:
            sys.exit(f"{k}: an exhausted answer; this script judges saved answers only")
        qa = h2h.qa_of(data, r["qid"])
        prompt = ACCURACY_PROMPT.format(question=qa["question"], gold_answer=qa["answer"], generated_answer=r["answer"])
        items[(r["arm"], str(r["cutoff"]), r["qid"])] = (Item(f"official {r['arm']} {r['cutoff']} {r['qid']}", "", prompt,
                                                              manifest, label_in), old[k])
    return items


def items_of(bench: str, out: Path, only: tuple[str, ...] = (), judge: str = "codex") -> dict:
    m = manifest_of(bench, judge)
    items = (locomo_items(out, h2h.load(h2h.LOCOMO / "data" / "locomo10.json"), m) if bench == "locomo"
             else lme_items(out, m))
    if only:
        items = {k: v for k, v in items.items() if f"{k[0]}:{k[1]}" in only}
        if not items:
            sys.exit(f"--only {' '.join(only)} matches no (arm, cutoff) in {out}")
    return items


def judge(bench: str, out: Path, slots: int, only: tuple[str, ...] = (), judge: str = "codex") -> None:
    items = items_of(bench, out, only, judge)
    log = out / SUBS[judge] / "calls-judge.jsonl"
    log.parent.mkdir(exist_ok=True)
    if judge == "openai":
        llm = OpenAIChat(log, PUBLISHED[bench], slots=slots)
    else:
        codex_judge.PREAMBLE = PREAMBLE
        llm = codex_judge.CodexJudge(log=log, slots=slots)
    ledger = Ledger(log)
    require(llm, manifest_of(bench, judge))
    todo = sorted((it for it, _ in items.values() if ledger.choose(it).status == "open"), key=lambda it: " bm25 " in it.tag)
    print(f"{NAMES[bench]} {out.name}: {len(items)} answers, {len(todo)} to judge", flush=True)
    with ThreadPoolExecutor(slots) as pool:
        for i, _ in enumerate(pool.map(lambda it: ledger.settle(it, llm), todo), 1):
            if i % 250 == 0:
                print(f"  {i}/{len(todo)}", flush=True)


def pct(keys: list, verdict: dict) -> float:
    return 100 * sum(verdict[k] for k in keys) / len(keys)


def score(bench: str, out: Path, only: tuple[str, ...] = (), judge: str = "codex") -> None:
    """Official-prompt accuracy per arm and cutoff, over all items and over the primary, beside the registered judge."""
    items = items_of(bench, out, only, judge)
    sub = out / SUBS[judge]
    ledger = Ledger(sub / "calls-judge.jsonl")
    choices = {k: ledger.choose(it) for k, (it, _) in items.items()}
    unsettled(choices, "official verdicts")
    new = {k: c.status == "valid" and bool(c.value) for k, c in choices.items()}
    old = {k: v for k, (_, v) in items.items()}
    smoke = smoke_excluded(bench, sorted({k[2] for k in items}))
    on = (f"the published judge {PUBLISHED[bench].model} with its published settings" if judge == "openai" else
          f"the published judge prompt and parse on codex gpt-5.6-sol medium (published runs judge with "
          f"{PUBLISHED_JUDGE[bench]})")
    lines = [f"{NAMES[bench]}, {out.name}: {on}; answers as saved, none asked again"]
    js = {}
    for arm, cut in sorted({k[:2] for k in items}, key=lambda ac: (ac[0] == "bm25", ac[0], -int(ac[1].removeprefix("top_")))):
        every = sorted(k for k in items if k[:2] == (arm, cut))
        prim = [k for k in every if k[2] not in smoke]
        same = 100 * sum(new[k] == old[k] for k in every) / len(every)
        row = {"official_all": pct(every, new), "n_all": len(every), "official_primary": pct(prim, new), "n_primary": len(prim),
               "registered_primary": pct(prim, old), "same_verdict": same}
        js[f"{arm} {cut}"] = row
        lines.append(f"{arm:>10} {cut:>8}  official {row['official_all']:5.1f} n={len(every)}  primary {row['official_primary']:5.1f} "
                     f"n={len(prim)}  registered judge {row['registered_primary']:5.1f}  same verdict {same:5.1f}%")
    lines += exhausted_lines(choices, "official verdicts")
    name = "score" + "".join(f"-{o.replace(':', '-')}" for o in only)
    (sub / f"{name}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (sub / f"{name}.json").write_text(json.dumps(js, indent=1), encoding="utf-8")
    print("\n".join(lines))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("judge", "score"))
    ap.add_argument("--bench", choices=tuple(NAMES), required=True)
    ap.add_argument("--out", type=Path, required=True, help="a finished run folder: results.jsonl or answers.jsonl")
    ap.add_argument("--slots", type=int, default=codex_judge.DEFAULT_SLOTS, help="concurrent codex processes")
    ap.add_argument("--only", nargs="+", default=(), help="ARM:CUTOFF, e.g. hippo-emb:top_200 or hippo-emb:200")
    ap.add_argument("--judge", choices=tuple(SUBS), default="codex", help="openai: the published judge (dated notes 22)")
    a = ap.parse_args()
    if a.stage == "score":
        score(a.bench, a.out, tuple(a.only), a.judge)
        return
    with one_writer(a.out):
        judge(a.bench, a.out, a.slots, tuple(a.only), a.judge)


if __name__ == "__main__":
    main()
