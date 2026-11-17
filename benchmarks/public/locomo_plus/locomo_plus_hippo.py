"""LoCoMo-Plus (arXiv 2602.10715) through its released evaluation framework, over hippo's retrieval
(docs/evals/notes-2026-11-17-locomo-plus.md).

xjtuleeyf/Locomo-Plus 059f4e3d, imported from the pinned clone (no licence file, so none is copied): the 2,387 unified
samples of data/unified_input.py (1,986 LoCoMo questions, 401 Cognitive cue-trigger pairs stitched by build_conv.py),
one gpt-4o answer per sample on task_eval/utils.py's input (CONV_START_PROMPT, the task instruction, then the body) at
evaluate.sh's temperature 0.3 and evaluate_qa.py's max_tokens 1024, judged by llm_as_judge.py's category prompts at
temperature 0 and max_tokens 512, scored correct 1, partial 0.5, wrong 0. The paper releases no memory-system code: here
the body holds hippo's top 5 turns in the framework's own line format in place of the whole dialogue (the paper's RAG
rows append the top-5 segments), and the judge is gpt-4o, the paper's second judge (Table 3), not Table 1's unstated one.
Usage (runner venv): python -I locomo_plus_hippo.py {ingest,retrieve,answer,judge,score} [--arm hippo-emb|bm25]
  [--smoke] [--slots 8] [--shards 2] [--port-base 9601]
"""
from __future__ import annotations

import argparse
import calendar
import datetime as dt
import functools
import importlib
import json
import subprocess
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent)]
from qa import harness  # noqa: E402
from qa.harness import pred_path, sha_bytes  # noqa: E402
from qa.ledger import Item, Ledger, Manifest, exhausted_lines, one_writer, require, smoke_excluded, unsettled  # noqa: E402
from qa.openai_llm import EFFORT, OpenAIChat, Settings  # noqa: E402
from qa.vendor_pin import check  # noqa: E402
from server_arms import SERVER_ARM  # noqa: E402

NAME = "LoCoMo-Plus"
CLONE = Path.home() / "hippo-bench" / "vendor" / "Locomo-Plus"
COMMIT = "059f4e3d38f7f1f96765e8e2cb7de3097551bffb"
BLOBS = {"data/build_conv.py": "7a761d108d65bb525541aea66c8f4775cd287d06",
         "data/unified_input.py": "4004928e4002309f5c985fc687d821f799ba6768",
         "data/locomo10.json": "d95b872480b413d935821fdc3c84f8a8f5f29e73",
         "data/locomo_plus.json": "9e0dfe899d8abb9b42dc9c2ffd82eaaf1b07b605",
         "evaluation_framework/task_eval/utils.py": "a0f5d2167b1e6f3ebd467b5cee9cfed74bd02510",
         "evaluation_framework/task_eval/prompt.py": "d818cf728aca7be43be32b25dcb01a3f33aef292",
         "evaluation_framework/task_eval/llm_as_judge.py": "055fcc96d1c838ea2e179d389062f952e60aa753",
         "evaluation_framework/task_eval/evaluate_qa.py": "24cfe91845f4eeb4b0ee5ee0ec09a755d1c9cd90",
         "evaluation_framework/scripts/evaluate.sh": "6f303d73572012524535bde002a3cae92a0b25e2",
         "evaluation_framework/scripts/judge.sh": "3f0f459005dbeeddafeac1ae1e64d0e00c297659"}
TOPK = 5  # the paper's RAG rows: "the top-5 most relevant dialogue segments"; no top-k is given for memory systems
FOUR_O = "gpt-4o-2024-08-06"  # "GPT-4o" in Table 1; the gpt-4o alias's snapshot through 2025
ANSWERER = Settings(FOUR_O, temperature=0.3, max_tokens=1024)  # evaluate.sh TEMP 0.3; evaluate_qa.py --max-tokens 1024
JUDGE = Settings(FOUR_O, temperature=0.0, max_tokens=512)  # llm_as_judge.py --temperature 0.0, --max-tokens 512
A_MAN, J_MAN = Manifest(FOUR_O, EFFORT, ANSWERER.cli), Manifest(FOUR_O, EFFORT, JUDGE.cli)
LOCOMO = ("single-hop", "multi-hop", "temporal", "common-sense", "adversarial")  # Table 1's column order
OUT = Path.home() / "hippo-bench" / "results-r2" / "locomo-plus"
SMOKE = (0, 496, 992, 1488, 1986)  # four LoCoMo questions spread over the 1,986 and the first Cognitive sample


class Run:
    smoke: bool = False


@functools.lru_cache(maxsize=1)
def vendor() -> dict:
    """The framework's modules, from the pinned clone; build_conv imports by its bare name, as unified_input does."""
    check(CLONE, COMMIT, BLOBS)
    for p in (CLONE / "data", CLONE / "evaluation_framework"):
        if str(p) not in sys.path:
            sys.path.insert(0, str(p))
    mods = {n: importlib.import_module(n) for n in ("build_conv", "unified_input", "task_eval.utils",
                                                     "task_eval.llm_as_judge")}
    for m in mods.values():
        if not Path(m.__file__).resolve().is_relative_to(CLONE.resolve()):
            sys.exit(f"{m.__name__} resolves to {m.__file__}, not the Locomo-Plus clone")
    return mods


def epoch(t: dt.datetime) -> int:
    return calendar.timegm(t.timetuple())


def line(turn: dict, blip: bool) -> str:
    """A turn as the framework writes it; only the LoCoMo context adds the shared image's caption."""
    text = (turn.get("text") or "").strip()
    if blip and "blip_caption" in turn:
        return f'{turn.get("speaker", "?")} said, "{text}" and shared {turn["blip_caption"]}.'
    return f'{turn.get("speaker", "?")} said, "{text}"'


@functools.lru_cache(maxsize=1)
def samples() -> list[dict]:
    """The unified samples in the framework's order, each with its store's user, turns and retrieval query."""
    m = vendor()
    raw = json.loads((CLONE / "data" / "locomo10.json").read_text(encoding="utf-8"))
    plus = json.loads((CLONE / "data" / "locomo_plus.json").read_text(encoding="utf-8"))
    unified = m["unified_input"].build_unified_samples(CLONE / "data")
    out, convs = [], {}
    for k, item in enumerate(raw):
        conv = item["conversation"]
        _, _, sessions, times = m["build_conv"].analyze_conversation(conv)
        convs[f"locomo-{k}"] = [{"role": "user", "content": line(t, True), "timestamp": epoch(ts)}
                                for sess, ts in zip(sessions, times) for t in sess]
        out += [{"user_id": f"locomo-{k}", "query": qa.get("question", "")} for qa in item.get("qa") or []]
    for j, p in enumerate(plus):
        turns, query = stitched(m["build_conv"], p, raw[j % len(raw)])
        convs[f"plus-{j:03d}"] = turns
        out.append({"user_id": f"plus-{j:03d}", "query": query["text"], "trigger_line": line(query, False)})
    if len(out) != len(unified):
        raise RuntimeError(f"{len(out)} samples here, {len(unified)} in unified_input")
    return [{**u, **o, "qid": f"lp-{i:04d}", "turns": convs[o["user_id"]]} for i, (u, o) in enumerate(zip(unified, out))]


def stitched(bc, plus: dict, item: dict) -> tuple[list[dict], dict]:
    """build_context's events with their times: the store holds every turn but the trigger, which is the query."""
    _, _, sessions, times = bc.analyze_conversation(item["conversation"])
    _, cue_time, query_time = bc.compute_insertion(times, plus["time_gap"])
    ctx = bc.build_context(plus, item)
    events = [(t, s) for s, t in zip(sessions, times)] + [(cue_time, ctx["cue_turns"]), (query_time, ctx["query_turns"])]
    events.sort(key=lambda x: x[0])
    flat = [(t, turn) for t, content in events for turn in content]
    if [x for _, x in flat] != ctx["dialogue"] or len(ctx["query_turns"]) != 1 or flat[-1][1] is not ctx["query_turns"][0]:
        raise RuntimeError("the stitched dialogue differs from build_context's")
    return [{"role": "user", "content": line(x, False), "timestamp": epoch(t)} for t, x in flat[:-1]], flat[-1][1]


def conversations():
    seen = {}
    for s in samples():
        seen.setdefault(s["user_id"], s["turns"])
    return seen.items()


def questions() -> list[dict]:
    pick = SMOKE if Run.smoke else range(len(samples()))
    return [{"qid": s["qid"], "user_id": s["user_id"], "question": s["query"], "ask_after": None, "i": i}
            for i in pick for s in [samples()[i]]]


def hits(out: Path, arm: str, qid: str) -> list[dict]:
    raw = pred_path(out, arm, qid).read_bytes()
    if sha_bytes(raw) != json.loads((out / "predicted" / "manifest.json").read_text(encoding="utf-8"))[arm][qid]:
        sys.exit(f"predicted file for {arm} {qid} differs from its manifest")
    return json.loads(raw)["results"]


def body(s: dict, found: list[dict]) -> str:
    """The input_prompt with hippo's hits in place of the whole dialogue, oldest first, in the framework's format:
    LoCoMo as DATE and CONVERSATION blocks then the question; Cognitive as bare lines then the trigger."""
    order = {(t["content"].strip(), t["timestamp"]): n for n, t in enumerate(s["turns"])}
    kept = sorted(((order[(h["memory"].removeprefix("user: "), stamp(h))], h) for h in found), key=lambda x: x[0])
    turns = [s["turns"][n] for n, _ in kept]
    if s["category"] == "Cognitive":
        return "\n".join([t["content"] for t in turns] + [s["trigger_line"]])
    dates = session_dates(s)
    blocks = defaultdict(list)
    for t in turns:
        blocks[t["timestamp"]].append(t["content"])
    ctx = "".join(f"DATE: {dates[ts]}\nCONVERSATION:\n" + "".join(f"{c}\n" for c in cs) + "\n" for ts, cs in blocks.items())
    return ctx.rstrip() + "\n\nQuestion: " + s["query"]


def stamp(hit: dict) -> int:
    return epoch(dt.datetime.fromisoformat(hit["created_at"].replace("Z", "+00:00")))


def session_dates(s: dict) -> dict[int, str]:
    conv = json.loads((CLONE / "data" / "locomo10.json").read_text(encoding="utf-8"))[int(s["user_id"].split("-")[1])]
    c = conv["conversation"]
    return {epoch(vendor()["build_conv"].parse_locomo_session_time(c[k])): c[k] for k in c if k.endswith("_date_time")}


def answer_items(out: Path, arm: str, qs: list[dict]) -> dict[str, Item]:
    """call_llm's one user message: _build_model_input(body, category)."""
    build = vendor()["task_eval.utils"]._build_model_input
    return {q["qid"]: Item(f"lp answer {arm} {q['qid']}", "", build(body(s, hits(out, arm, q["qid"])), s["category"]),
                           A_MAN) for q in qs for s in [samples()[q["i"]]]}


def judge_item(arm: str, q: dict, prediction: str) -> Item:
    """_judge_one_record's prompt, sent by call_model with no category, so _prepend_conv_prefix comes first."""
    m, s = vendor(), samples()[q["i"]]
    gold = s.get("answer")
    prompt = m["task_eval.llm_as_judge"].get_judge_prompt(s["category"] or "default", s.get("evidence", ""),
                                                          prediction, "" if gold is None else gold)
    return Item(f"lp judge {arm} {q['qid']}", "", m["task_eval.utils"]._prepend_conv_prefix(prompt), J_MAN)


def settled(out: Path, name: str, items: dict) -> dict:
    ledger = Ledger(out / f"calls-{name}.jsonl")
    got = {k: ledger.choose(it) for k, it in items.items()}
    unsettled(got, name)
    return got


def run_stage(out: Path, name: str, settings: Settings, man: Manifest, items: dict, slots: int) -> None:
    log = out / f"calls-{name}.jsonl"
    ledger, llm = Ledger(log), OpenAIChat(log, settings, slots=slots)
    require(llm, man)
    with ThreadPoolExecutor(slots) as pool:
        list(pool.map(lambda k: ledger.settle(items[k], llm), items))


def judge_items(out: Path, arm: str, qs: list[dict]) -> dict:
    """A sample whose answer had no valid reply in 3 asks is judged on "", as a failed call_llm returns no text."""
    answers = settled(out, "answer", answer_items(out, arm, qs))
    return {q["qid"]: judge_item(arm, q, answers[q["qid"]].value if answers[q["qid"]].status == "valid" else "")
            for q in qs}


def score(out: Path, arm: str, qs: list[dict]) -> None:
    m = vendor()["task_eval.llm_as_judge"]
    verdicts = settled(out, "judge", judge_items(out, arm, qs))
    recs = {q["qid"]: {"category": samples()[q["i"]]["category"],
                       "judge_score": m.label_to_score(m._parse_judge_response(verdicts[q["qid"]].value or "")[0])}
            for q in qs}
    if Run.smoke:
        lines = [f"SMOKE {NAME}, {arm}: integrity only, never scored or read",
                 f"samples {len(qs)}: " + ", ".join(f"{q['qid']} {recs[q['qid']]['category']}" for q in qs),
                 f"judge labels parsed: {sum(bool(m._parse_judge_response(c.value or '')[0]) for c in verdicts.values())}"]
    else:
        every = [q["qid"] for q in qs]
        lines = [f"{NAME} via its framework, {arm}: top {TOPK}, {FOUR_O} answers and judges (Locomo-Plus {COMMIT[:8]})"]
        for label, ids in (("all items", every), ("primary", [i for i in every if i not in
                                                                smoke_excluded("locomo-plus", every)])):
            lines += table_lines(m, [recs[i] for i in ids], label)
    lines += token_lines(out, len(qs)) + exhausted_lines(settled(out, "answer", answer_items(out, arm, qs)), "answers")
    (out / ("smoke.txt" if Run.smoke else "score.txt")).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def table_lines(m, recs: list[dict], label: str) -> list[str]:
    """Table 1's cells: each category's mean, the LoCoMo mean over its five categories' items, LoCoMo-Plus, the gap."""
    cats = m._compute_summary(recs)["by_category"]
    loc = [r for r in recs if r["category"] in LOCOMO]
    lm = 100 * sum(r["judge_score"] for r in loc) / max(len(loc), 1)
    plus = 100 * cats.get("Cognitive", {}).get("avg", 0.0)
    cells = "  ".join(f"{c} {100 * cats.get(c, {}).get('avg', 0.0):.2f}" for c in LOCOMO)
    return [f"{label}: {cells}  LoCoMo {lm:.2f}  LoCoMo-Plus {plus:.2f}  gap {lm - plus:.2f}  n={len(recs)}"]


def token_lines(out: Path, n: int) -> list[str]:
    lines = []
    for name in ("answer", "judge"):
        p = out / f"calls-{name}.jsonl"
        recs = [r for r in map(json.loads, p.read_text(encoding="utf-8").splitlines())] if p.exists() else []
        use = [r.get("usage") or {} for r in recs if r.get("event") == "ok"]
        pin, pout = sum(u.get("prompt_tokens") or 0 for u in use), sum(u.get("completion_tokens") or 0 for u in use)
        lines.append(f"{name}: {len(use)} calls, {pin} in, {pout} out, {(pin + pout) / n:.0f} tokens per sample")
    return lines


def setup(stage: str, out: Path, arm: str) -> list[dict]:
    qs, qfile = questions(), out / "questions.json"
    if stage == "ingest":
        if qfile.exists() and json.loads(qfile.read_text(encoding="utf-8"))["qids"] != [q["qid"] for q in qs]:
            sys.exit(f"{qfile} holds another question set; use a new folder")
        repo = HERE.parents[2]
        cfg = {"lane": "locomo-plus, notes-2026-11-17-locomo-plus.md", "arm": arm, "topk": TOPK, "smoke": Run.smoke,
               "commit": COMMIT, "blobs": BLOBS, "answerer": f"{FOUR_O} {ANSWERER.cli}", "judge": f"{FOUR_O} {JUDGE.cli}",
               "hippo_memory": json.loads((repo / "package.json").read_text(encoding="utf-8"))["version"],
               "repo_head": subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True,
                                           text=True, check=True).stdout.strip(),
               "script_sha256": sha_bytes(Path(__file__).read_bytes())}
        out.mkdir(parents=True, exist_ok=True)
        qfile.write_text(json.dumps({"qids": [q["qid"] for q in qs]}), encoding="utf-8")
        (out / "config.json").write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    elif not qfile.exists() or json.loads(qfile.read_text(encoding="utf-8"))["qids"] != [q["qid"] for q in qs]:
        sys.exit(f"{qfile} is missing or holds another question set; run ingest first")
    return qs


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("ingest", "retrieve", "answer", "judge", "score"))
    ap.add_argument("--arm", choices=("hippo-emb", "bm25"), default="hippo-emb")
    ap.add_argument("--smoke", action="store_true", help=f"samples {SMOKE} into OUT/smoke/ARM")
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--shards", type=int, default=2)
    ap.add_argument("--port-base", type=int, default=9601)
    a = ap.parse_args()
    Run.smoke = a.smoke
    out = (OUT / "smoke" if a.smoke else OUT) / a.arm
    if a.stage == "score":
        return score(out, a.arm, setup(a.stage, out, a.arm))
    with one_writer(out):
        qs = setup(a.stage, out, a.arm)
        if a.stage in ("ingest", "retrieve"):
            ns = argparse.Namespace(out=out, arm=a.arm, arms={a.arm: SERVER_ARM[a.arm]}, store_from=None,
                                    shards=a.shards, port_base=a.port_base, stage=a.stage)
            harness.stage_ingest_retrieve(ns, sys.modules[__name__], qs)
        elif a.stage == "answer":
            run_stage(out, "answer", ANSWERER, A_MAN, answer_items(out, a.arm, qs), a.slots)
        else:
            run_stage(out, "judge", JUDGE, J_MAN, judge_items(out, a.arm, qs), a.slots)


if __name__ == "__main__":
    main()
