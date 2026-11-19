"""PrefEval as MemOS's evaluation suite runs it, over hippo's own retrieval (prereg dated notes 30, lane F).

MemTensor/MemOS 3a16e5fe evaluation/scripts: the implicit-persona split (PrefEval/prefeval_preprocess.py), each row's
conversation and then irre_10's 10 turns in one store per row (pref_memos.py:44-63, ADD_TURN=10), the top 10 memories as
"- <memory>" lines (pref_memos.py:100-108, TOP_K=10), one gpt-4o-mini answer per row with PREFEVAL_ANSWER_PROMPT as the
system message, the question as the user message and no other setting (pref_memos.py:159-165), then pref_eval.py's four
gpt-4o-mini checks and classify_error_type. The score is the Personalized Response share of all rows (pref_eval.py:371).
No competitor arm runs (Keith, 13 Nov).
Usage (runner venv): python -I prefeval_memos.py {prepare,ingest,retrieve,answer,judge,score} --arm {hippo-emb,bm25}
  [--limit 5] [--slots 8] [--shards 2] [--port-base 9301]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]
from qa import harness  # noqa: E402
from qa.harness import pred_path, sha_bytes  # noqa: E402
from qa.ledger import Item, Ledger, Manifest, exhausted_lines, one_writer, require, smoke_excluded, unsettled  # noqa: E402
from qa.memos_pref_prompts import (CHECK_ACKNOWLEDGE, CHECK_HALLUCINATE, CHECK_HELPFUL, CHECK_VIOLATE,  # noqa: E402
                                   PREFEVAL_ANSWER_PROMPT, classify_error_type, irre_10, parse_xml_response)
from qa.openai_llm import EFFORT, OpenAIChat, Settings  # noqa: E402
from server_arms import SERVER_ARM  # noqa: E402

NAME = "PrefEval (implicit persona, 10 irrelevant turns)"
TOPK = 10  # run_prefeval_eval.sh:12
DATA = Path.home() / "hippo-bench" / "datasets" / "prefeval" / "implicit_persona"
PARQUET = DATA / "train-00000-of-00001.parquet"  # HF siyanzhao/prefeval_implicit_persona at 2c4b0ca8, its one split
PARQUET_SHA = "23163a86fe57a32a9665d1ecaac333b128ee4268ac9ce8928d036fb0bfb11314"  # the HF LFS oid
ROWS = DATA / "pref_processed.jsonl"
OUT = Path.home() / "hippo-bench" / "results-r2" / "prefeval-memos"
ANSWERER = Settings("gpt-4o-mini-2024-07-18", temperature=None)  # pref_memos.py:165 sends the model and messages only
CHECKER = Settings("gpt-4o-mini-2024-07-18", max_tokens=500)  # pref_eval.py:27-34, temperature 0
A_MAN, C_MAN = Manifest(ANSWERER.model, EFFORT, ANSWERER.cli), Manifest(CHECKER.model, EFFORT, CHECKER.cli)
NO_ANSWER = "No answer in 3 asks"  # MemOS writes no line for such a row (pref_memos.py:171-174); here it scores wrong


def prepare() -> None:
    """prefeval_preprocess.py: the rows in order, each conversation as user and assistant messages in turn order, a turn
    without both sides left out (restructure_conversation_in_json, lines 29-60)."""
    import pandas as pd
    if sha_bytes(PARQUET.read_bytes()) != PARQUET_SHA:
        sys.exit(f"{PARQUET} is not the pinned file; fetch it again at commit 2c4b0ca8")
    with ROWS.open("w", encoding="utf-8", newline="\n") as f:
        for r in pd.read_parquet(PARQUET).to_dict("records"):
            conv = []
            for k in sorted(r["conversation"], key=int):
                t = r["conversation"][k]
                if t and isinstance(t, dict) and "user" in t and "assistant" in t:
                    conv += [{"role": "user", "content": t["user"]}, {"role": "assistant", "content": t["assistant"]}]
            f.write(json.dumps({**r, "conversation": conv}, ensure_ascii=False) + "\n")
    print(f"wrote {ROWS}")


def rows() -> list[dict]:
    if not ROWS.exists():
        sys.exit(f"{ROWS} is missing; run `python -I prefeval_memos.py prepare` first")
    with ROWS.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f]


def questions() -> list[dict]:
    """One question per row; the row index is MemOS's line index i (pref_memos.py:37-38)."""
    return [{"qid": f"pref-{i:04d}", "user_id": f"pref-{i:04d}", "question": r["question"], "preference": r["preference"],
             "category": r["topic"], "ask_after": None} for i, r in enumerate(rows())]


def conversations():
    """Each row's store: its conversation, then irre_10 (pref_memos.py:44-45). The data holds no dates."""
    for i, r in enumerate(rows()):
        yield f"pref-{i:04d}", [{"role": m["role"], "content": m["content"], "timestamp": None}
                                for m in r["conversation"] + irre_10]


def memories(out: Path, arm: str, qid: str) -> list[str]:
    """The retrieval's memory texts in rank order; stops on a file the manifest did not hash."""
    raw = pred_path(out, arm, qid).read_bytes()
    if sha_bytes(raw) != json.loads((out / "predicted" / "manifest.json").read_text(encoding="utf-8"))[arm][qid]:
        sys.exit(f"predicted file for {arm} {qid} differs from its manifest")
    return [r["memory"] for r in json.loads(raw)["results"]]


def memories_text(mems: list[str]) -> str:
    """pref_memos.py:102-108: a "- " line per memory, then a newline and MemOS's preference string, which hippo has not."""
    return "\n".join(f"- {m}" for m in mems) + "\n"


def answer_items(out: Path, arm: str, qs: list[dict]) -> dict[str, Item]:
    return {q["qid"]: Item(f"pfmemos answer {arm} {q['qid']}",
                           PREFEVAL_ANSWER_PROMPT.format(context=memories_text(memories(out, arm, q["qid"]))),
                           q["question"], A_MAN) for q in qs}


def check_items(arm: str, q: dict, answer: str, ack: str | None) -> dict[str, Item]:
    """pref_eval.py:199-212: acknowledge first, then violate, hallucinate over the restatement it found, and helpful.
    A blank restatement makes no hallucinate call (lines 111-112)."""
    def item(kind: str, template: str, **fields: str) -> Item:
        return Item(f"pfmemos {kind} {arm} {q['qid']}", "", template.format(**fields), C_MAN)
    out = {"acknowledge": item("acknowledge", CHECK_ACKNOWLEDGE, question=q["question"], response=answer)}
    if ack is None:
        return out
    restatement = parse_xml_response(ack, "preference")
    out["violate"] = item("violate", CHECK_VIOLATE, preference=q["preference"], question=q["question"], response=answer)
    if restatement.strip():
        out["hallucinate"] = item("hallucinate", CHECK_HALLUCINATE, preference=q["preference"], restatement=restatement)
    out["helpful"] = item("helpful", CHECK_HELPFUL, question=q["question"], response=answer)
    return out


def reply(choice) -> str:
    """A check with no valid reply in 3 asks reads as MemOS reads a failed call: "" (pref_eval.py:36-38)."""
    return choice.value if choice.status == "valid" else ""


def settled_answers(out: Path, arm: str, qs: list[dict]) -> dict:
    ledger = Ledger(out / "calls-answer.jsonl")
    got = {qid: ledger.choose(it) for qid, it in answer_items(out, arm, qs).items()}
    unsettled(got, "answers")
    return got


def all_checks(arm: str, qs: list[dict], answers: dict, ledger: Ledger, settle=None, slots: int = 1) -> dict:
    """Each answered row's check choices, the acknowledge check first; settle asks open ones, else the log is read."""
    pick = settle or ledger.choose
    live = [q for q in qs if answers[q["qid"]].status == "valid"]
    with ThreadPoolExecutor(slots) as pool:
        acks = list(pool.map(lambda q: pick(check_items(arm, q, answers[q["qid"]].value, None)["acknowledge"]), live))
        rest = [(q["qid"], kind, it) for q, a in zip(live, acks)
                for kind, it in check_items(arm, q, answers[q["qid"]].value, reply(a)).items() if kind != "acknowledge"]
        done = list(pool.map(lambda x: pick(x[2]), rest))
    got = {(q["qid"], "acknowledge"): a for q, a in zip(live, acks)}
    got.update({(qid, kind): c for (qid, kind, _), c in zip(rest, done)})
    return got


def evaluation(qid: str, checks: dict) -> dict:
    """pref_eval.py:214-219, each check's answer as parse_xml_response reads it."""
    hall = checks.get((qid, "hallucinate"))
    return {"violate_preference": {"answer": parse_xml_response(reply(checks[(qid, "violate")]), "answer")},
            "acknowledge_preference": {"answer": parse_xml_response(reply(checks[(qid, "acknowledge")]), "answer")},
            "hallucinate_preference": {"answer": "No" if hall is None else parse_xml_response(reply(hall), "answer")},
            "helpful_response": {"answer": parse_xml_response(reply(checks[(qid, "helpful")]), "answer")}}


def authors_right(ev: dict) -> bool:
    """amazon-science/PrefEval get_preference_following_accuracy_generation_task.py:69-82 over the same four replies."""
    ack = "yes" in ev["acknowledge_preference"]["answer"].lower()
    hallucinated = ack and "yes" in ev["hallucinate_preference"]["answer"].lower()
    violated = "yes" in ev["violate_preference"]["answer"].lower()
    unhelpful = "no" in ev["helpful_response"]["answer"].lower()
    return not any([ack and not hallucinated and violated and not unhelpful, ack and hallucinated and violated and not
                    unhelpful, not ack and violated and not unhelpful, unhelpful])


def run_answers(out: Path, arm: str, qs: list[dict], slots: int) -> None:
    ledger, llm = Ledger(out / "calls-answer.jsonl"), OpenAIChat(out / "calls-answer.jsonl", ANSWERER, slots=slots)
    require(llm, A_MAN)
    todo = answer_items(out, arm, qs)
    print(f"{arm}: {len(todo)} answers into {out}", flush=True)
    with ThreadPoolExecutor(slots) as pool:
        for i, _ in enumerate(pool.map(lambda k: ledger.settle(todo[k], llm), todo), 1):
            if i % 100 == 0:
                print(f"  {i}/{len(todo)}", flush=True)


def run_checks(out: Path, arm: str, qs: list[dict], slots: int) -> None:
    answers = settled_answers(out, arm, qs)
    ledger, llm = Ledger(out / "calls-judge.jsonl"), OpenAIChat(out / "calls-judge.jsonl", CHECKER, slots=slots)
    require(llm, C_MAN)
    print(f"{arm}: four checks for {sum(c.status == 'valid' for c in answers.values())} answers into {out}", flush=True)
    all_checks(arm, qs, answers, ledger, settle=lambda it: ledger.settle(it, llm), slots=slots)


def tokens(choices) -> tuple[int, int]:
    use = [(c.record.get("usage") or {}) for c in choices if c.record]
    return sum(u.get("prompt_tokens") or 0 for u in use), sum(u.get("completion_tokens") or 0 for u in use)


def cost_lines(answers: dict, checks: dict, n: int) -> list[str]:
    (ain, aout), (cin, cout) = tokens(answers.values()), tokens(checks.values())
    total = ain + aout + cin + cout
    return [f"tokens per row: answer {ain / n:.0f} in, {aout / n:.0f} out; checks {cin / n:.0f} in, {cout / n:.0f} out; "
            f"{total / n:.0f} in all, {total / n * 1000 / 1e6:.2f}M per 1,000 rows",
            *exhausted_lines(answers, "answers"), *exhausted_lines(checks, "checks")]


def write(path: Path, lines: list[str]) -> None:
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def score(out: Path, arm: str, qs: list[dict], smoke: bool) -> None:
    """The Personalized Response share over all rows (pref_eval.py:230-250), every error type, and the PrefEval authors'
    accuracy; a smoke run writes only integrity counts and tokens to smoke.txt, never a score."""
    answers, ledger = settled_answers(out, arm, qs), Ledger(out / "calls-judge.jsonl")
    checks = all_checks(arm, qs, answers, ledger)
    unsettled(checks, "checks")
    n, valid = len(qs), {q["qid"] for q in qs if answers[q["qid"]].status == "valid"}
    if smoke:
        tagged = Counter(k for (_, k), c in checks.items() if parse_xml_response(reply(c), "answer") in ("Yes", "No"))
        return write(out / "smoke.txt", [f"SMOKE {NAME}, {arm}: integrity only, never scored or read",
                                         f"rows {n}, answers valid {len(valid)}, checks asked {len(checks)}, "
                                         f"with a Yes or No answer tag {dict(tagged)}", *cost_lines(answers, checks, n)])
    evs = {i: evaluation(i, checks) for i in valid}
    types = {q["qid"]: classify_error_type(evs[q["qid"]]) if q["qid"] in valid else NO_ANSWER for q in qs}
    right = {q["qid"]: q["qid"] in valid and authors_right(evs[q["qid"]]) for q in qs}
    every = [q["qid"] for q in qs]
    primary = [i for i in every if i not in smoke_excluded("prefeval-memos", every)]
    lines = [f"{NAME} as MemOS's suite runs it, {arm}: top {TOPK}, {ANSWERER.model} answers, "
             f"four {CHECKER.model} checks (MemTensor/MemOS 3a16e5fe)"]
    for name, ids in (("all rows", every), ("primary", primary)):
        share, acc = (100 * sum(types[i] == "Personalized Response" for i in ids) / len(ids),
                      100 * sum(right[i] for i in ids) / len(ids))
        lines.append(f"Personalized Response {share:5.2f}  authors' accuracy {acc:5.2f}  n={len(ids)}  {name}")
    lines.append("error types, all rows: " + "; ".join(f"{t} {100 * c / n:.2f}"
                                                      for t, c in Counter(types.values()).most_common()))
    lines.append(f"mean memories {sum(len(memories(out, arm, i)) for i in every) / n:.2f}")
    write(out / "score.txt", lines + cost_lines(answers, checks, n))


def setup(stage: str, out: Path, arm: str, limit: int) -> list[dict]:
    """The rows asked, fixed at ingest in questions.json with the config; a smoke takes every len//N-th, as harness.py."""
    qs = questions()
    if limit:
        qs = qs[::max(1, len(qs) // limit)][:limit]
    qfile = out / "questions.json"
    if stage == "ingest":
        if qfile.exists() and json.loads(qfile.read_text(encoding="utf-8"))["qids"] != [q["qid"] for q in qs]:
            sys.exit(f"{qfile} holds another question set; use a new folder")
        repo = HERE.parents[2]
        cfg = {"lane": "prefeval-memos, prereg dated notes 30" + (", amendment dated notes 32" if arm == "hippo-cap" else ""), "name": NAME, "arm": arm, "topk": TOPK, "limit": limit,
               "memos_commit": "3a16e5fe", "data": {PARQUET.name: PARQUET_SHA, ROWS.name: sha_bytes(ROWS.read_bytes())},
               "hippo_memory": json.loads((repo / "package.json").read_text(encoding="utf-8"))["version"],
               "repo_head": subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True,
                                           text=True, check=True).stdout.strip(),
               "script_sha256": sha_bytes(Path(__file__).read_bytes()),
               "prompts_sha256": sha_bytes((HERE.parent / "qa" / "memos_pref_prompts.py").read_bytes()),
               "answerer": f"{ANSWERER.model} {ANSWERER.cli}", "checker": f"{CHECKER.model} {CHECKER.cli}"}
        out.mkdir(parents=True, exist_ok=True)
        qfile.write_text(json.dumps({"qids": [q["qid"] for q in qs]}), encoding="utf-8")
        (out / "config.json").write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    elif not qfile.exists() or json.loads(qfile.read_text(encoding="utf-8"))["qids"] != [q["qid"] for q in qs]:
        sys.exit(f"{qfile} is missing or holds another question set; run ingest with the same --limit first")
    return qs


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("prepare", "ingest", "retrieve", "answer", "judge", "score"))
    ap.add_argument("--arm", choices=("hippo-emb", "hippo-cap", "bm25"), default="hippo-emb")
    ap.add_argument("--limit", type=int, default=0, help="smoke: this many rows, spread over the set, into OUT/smoke/ARM")
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--shards", type=int, default=2, help="ingest and retrieve: servers, each on its own rows")
    ap.add_argument("--port-base", type=int, default=9301)
    a = ap.parse_args()
    if a.stage == "prepare":
        return prepare()
    out = OUT / "smoke" / a.arm if a.limit else OUT / a.arm
    if a.stage == "score":
        return score(out, a.arm, setup(a.stage, out, a.arm, a.limit), bool(a.limit))
    with one_writer(out):
        qs = setup(a.stage, out, a.arm, a.limit)
        if a.stage in ("ingest", "retrieve"):
            ns = argparse.Namespace(out=out, arm=a.arm, arms={a.arm: SERVER_ARM[a.arm]}, store_from=None,
                                    shards=a.shards, port_base=a.port_base, stage=a.stage)
            harness.stage_ingest_retrieve(ns, sys.modules[__name__], qs)
        else:
            (run_answers if a.stage == "answer" else run_checks)(out, a.arm, qs, a.slots)


if __name__ == "__main__":
    main()
