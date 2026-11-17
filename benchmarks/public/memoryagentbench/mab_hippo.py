"""MemoryAgentBench (arXiv 2507.05257, ICLR 2026) as its authors' suite runs a memory method, over hippo's retrieval
(docs/evals/notes-2026-11-17-memoryagentbench.md).

HUST-AI-HYZ/MemoryAgentBench 53802608, its code copied into official.py: the 14 dataset configs of Table 3 (2,071
questions), each context cut by chunk_text_into_sentences and wrapped in its memorize template, one hippo store per
context, the top 10 for the query _extract_retrieval_query takes, then _handle_bm25_rag's reader, which the merged
knowl, agentmemory and total-agent-memory methods reuse: the system template, "Memory i:" blocks and the rag_agent
query to gpt-4o-mini at temperature 0.7 and the config's generation_max_length. Scored by post_process, LongMemEval by
longmem_qa_evaluate.py's gpt-4o check, InfBench-Sum by summarization_evaluate.py's three gpt-4o checks.
Regime memory: 4096-token chunks everywhere (Mem0, Cognee, Zep, MIRIX); rag: 512 on SH-QA, MH-QA, LME(S*) and both
FC tasks (HippoRAG-v2, BM25). No competitor arm runs.
Usage (runner venv): python -I mab_hippo.py {prepare,ingest,retrieve,answer,judge,score,estimate}
  [--regime memory|rag] [--arm hippo-emb|bm25] [--smoke] [--slots 8] [--shards 1] [--port-base 9401]
"""
from __future__ import annotations

import argparse
import contextlib
import json
import random
import shutil
import statistics
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]
import official  # noqa: E402
from qa import harness  # noqa: E402
from qa.harness import pred_path, sha_bytes  # noqa: E402
from qa.ledger import Item, Ledger, Manifest, exhausted_lines, one_writer, require, smoke_excluded, unsettled  # noqa: E402
from qa.openai_llm import EFFORT, OpenAIChat, Settings  # noqa: E402
from server_arms import SERVER_ARM  # noqa: E402

NAME = "MemoryAgentBench"
PIN = "538026089d1a8a8eff05121d0db89b388f360eba"
HF_REV = "7ea066982b140a19337e17e60d45d4076e042faf"  # ai-hyz/MemoryAgentBench; the code loads revision "main"
DATA = Path.home() / "hippo-bench" / "datasets" / "memoryagentbench"
PARQUET_SHA = {"Accurate_Retrieval": "56c3cd80fb6731a3e53cd1a6be3148f54df60ff2d290ee50e28f8acebf9655c1",
               "Test_Time_Learning": "5338753be48f925d03318eed66117286e3489025fabe050a547bd086cd7d79c0",
               "Long_Range_Understanding": "5ab175461954db67770d4a4cb69e569b513ebb96aceb9ee79b57f67488bcd539",
               "Conflict_Resolution": "24d5c3f09ce0ce15625cb9f8a98f44f0d864ca6c94d7b4ad04eb697ca3a5ff45"}
ENTITY_SHA = "63353aca481bc9558b502f91cb98f6fa26438796fdd7e0bc06b5a1532126e8b5"  # entity2id.json, for Recom
OUT = Path.home() / "hippo-bench" / "results-r2" / "memoryagentbench"
TOPK = 10  # retrieve_num of Simple_rag_gpt-4o-mini-bm25.yaml and every product config but Mem0's 100
AGENT = "Structure_rag_hippo"  # holds "rag", so get_template gives the rag_agent texts, as for Mem0, Zep and Cognee
MINI, FOUR_O = "gpt-4o-mini-2024-07-18", "gpt-4o-2024-08-06"  # the code sends the aliases gpt-4o-mini and gpt-4o
LME_JUDGE = Settings(FOUR_O, temperature=0.0, max_tokens=10)  # longmem_qa_evaluate.py:157-165
SUM_JUDGE = Settings(FOUR_O, temperature=0.1, max_tokens=4096, top_p=0.9, seed=42)  # summarization_evaluate.py:493
PREFIX = "user: "  # hippo-mem0-server.mjs addChunk stores a message as "role: content"
SMOKE_SEED = 20261117
PREPARED = DATA / "prepared-memory.jsonl"  # main sets the regime's file


@dataclass(frozen=True)
class Task:
    key: str  # our id, in each qid
    column: str  # the Table 3 column
    split: str  # dataset_config["dataset"], the Hugging Face split
    source: str  # dataset_config["sub_dataset"]
    samples: int  # max_test_samples
    gen: int  # generation_max_length, the answer's max_tokens
    metric: str  # the post_process key the README maps the column to, or "llm"
    rag_chunk: int  # the paper's RAG chunk size (section 4.1, App. F.3); every config file says 4096


def _icl(name: str, source: str) -> Task:
    return Task(name, "MCC", "Test_Time_Learning", source, 100, 20, "exact_match", 4096)


TASKS = (Task("sh_qa", "SH-QA", "Accurate_Retrieval", "ruler_qa1_197K", 100, 50, "substring_exact_match", 512),
         Task("mh_qa", "MH-QA", "Accurate_Retrieval", "ruler_qa2_421K", 100, 50, "substring_exact_match", 512),
         Task("lme", "LME(S*)", "Accurate_Retrieval", "longmemeval_s*", 5, 50, "llm", 512),
         Task("eventqa", "EventQA", "Accurate_Retrieval", "eventqa_full", 5, 40, "substring_exact_match", 4096),
         _icl("icl_banking77", "icl_banking77_5900shot_balance"), _icl("icl_clinic150", "icl_clinic150_7050shot_balance"),
         _icl("icl_nlu", "icl_nlu_8296shot_balance"), _icl("icl_trec_coarse", "icl_trec_coarse_6600shot_balance"),
         _icl("icl_trec_fine", "icl_trec_fine_6400shot_balance"),
         Task("recsys", "Recom", "Test_Time_Learning", "recsys_redial_full", 1, 300, "recsys_recall@5", 4096),
         Task("infbench_sum", "Summ", "Long_Range_Understanding", "infbench_sum_eng_shots2", 100, 1200, "llm", 4096),
         Task("detective_qa", "DetQA", "Long_Range_Understanding", "detective_qa", 10, 2000, "exact_match", 4096),
         Task("fc_sh", "FC-SH", "Conflict_Resolution", "factconsolidation_sh_262k", 1, 10, "substring_exact_match", 512),
         Task("fc_mh", "FC-MH", "Conflict_Resolution", "factconsolidation_mh_262k", 1, 10, "substring_exact_match", 512))
TASK = {t.key: t for t in TASKS}
COMPETENCY = {"AR": ("SH-QA", "MH-QA", "LME(S*)", "EventQA"), "TTL": ("MCC", "Recom"), "LRU": ("Summ", "DetQA"),
              "SF": ("FC-SH", "FC-MH")}  # Overall is the mean of the four averages (Table 3, every row)


def chunk_size(t: Task, regime: str) -> int:
    return 4096 if regime == "memory" else t.rag_chunk


def answerer(t: Task) -> Settings:
    """_handle_bm25_rag (agent.py:898-903): the config's temperature 0.7 and max_tokens, since the model holds gpt-4."""
    return Settings(MINI, temperature=0.7, max_tokens=t.gen)


def manifest(s: Settings) -> Manifest:
    return Manifest(s.model, EFFORT, s.cli)


def check_data() -> None:
    for split, want in PARQUET_SHA.items():
        if sha_bytes((DATA / "data" / f"{split}-00000-of-00001.parquet").read_bytes()) != want:
            sys.exit(f"{split} parquet is not the pinned file; fetch it again at {HF_REV}")
    if sha_bytes((DATA / "entity2id.json").read_bytes()) != ENTITY_SHA:
        sys.exit(f"entity2id.json is not the pinned file; fetch it again at {HF_REV}")


def source_rows(t: Task) -> list[dict]:
    """eval_data_utils.py:59-96 over the pinned parquet: the source's rows in file order, the first max_test_samples."""
    from datasets import Dataset
    raw = Dataset.from_parquet(str(DATA / "data" / f"{t.split}-00000-of-00001.parquet"), keep_in_memory=True)
    rows = raw.filter(lambda s: s.get("metadata", {}).get("source", "") == t.source, keep_in_memory=True)
    if len(rows) > t.samples:
        rows = rows.select(range(t.samples), keep_in_memory=True)
    return list(official._process_qa_list_fields(rows))


def task_contexts(t: Task, regime: str):
    """ConversationCreator over each row, then the RAG agent's memorize step (agent.py:713-714) on every chunk."""
    maker = official.ConversationCreator.__new__(official.ConversationCreator)
    maker.sub_dataset, maker.agent_name = t.source, AGENT
    template = official.get_template(t.source, "memorize", AGENT)
    for c, row in enumerate(source_rows(t)):
        context, pairs = maker._process_dataset_item(row)
        multi = len(row["questions"]) > 1 and len(row["answers"]) > 1  # conversation_creator.py:155
        qs = []
        for i, (query, answer, pair_id) in enumerate(pairs):
            meta = row.get("metadata") or {}
            qs.append({"qid": f"{t.key}-c{c:03d}-q{i:03d}", "task": t.key, "user_id": f"{t.key}-c{c:03d}",
                       "query": query, "answer": answer, "qa_pair_id": pair_id,
                       "raw_question": row["questions"][i if multi else 0],
                       "question_id": (row["question_ids"] or [None] * (i + 1))[i],
                       "question_type": (row["question_types"] or [None] * (i + 1))[i],
                       "keypoints": meta.get("keypoints")})
        chunks = [template.format(context=p, **({"time_stamp": time.strftime("%Y-%m-%d %H:%M:%S")}
                                                if "{time_stamp}" in template else {}))
                  for p in official.chunk_text_into_sentences(context, chunk_size=chunk_size(t, regime))]
        if any(ch != ch.strip() for ch in chunks):
            sys.exit(f"a {t.key} chunk has outer whitespace the server would trim")
        yield f"{t.key}-c{c:03d}", chunks, qs


def prepare(regime: str) -> None:
    check_data()
    ent = DATA / "processed_data" / "Recsys_Redial" / "entity2id.json"  # where _process_recsys_dataset opens it
    ent.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(DATA / "entity2id.json", ent)
    qlines = []
    with PREPARED.open("w", encoding="utf-8", newline="\n") as f:
        for t in TASKS:
            for user, chunks, qs in task_contexts(t, regime):
                f.write(json.dumps({"user": user, "chunks": chunks}, ensure_ascii=False) + "\n")
                qlines += [json.dumps(q, ensure_ascii=False) for q in qs]
            print(f"{t.key}: done", flush=True)
    qfile = DATA / "questions.jsonl"
    text = "\n".join(qlines) + "\n"
    if qfile.exists() and qfile.read_text(encoding="utf-8") != text:
        sys.exit(f"{qfile} holds other questions than this prepare made; check the data pins")
    qfile.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {PREPARED} and {qfile}: {len(qlines)} questions")


def questions() -> list[dict]:
    qfile = DATA / "questions.jsonl"
    if not qfile.exists():
        sys.exit(f"{qfile} is missing; run `python -I mab_hippo.py prepare` first")
    with qfile.open(encoding="utf-8") as f:
        qs = [json.loads(line) for line in f]
    for q in qs:  # the harness searches with q["question"]: the query the RAG handlers retrieve on (agent.py:871)
        q["question"], q["ask_after"] = official._extract_retrieval_query(None, q["query"]), None
    return qs


def conversations():
    """Each context's store: its wrapped chunks in order, one memory each."""
    with PREPARED.open(encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            yield r["user"], [{"role": "user", "content": ch, "timestamp": None} for ch in r["chunks"]]


def smoke_pick(qs: list[dict]) -> list[str]:
    """Five questions, seeded: one LME(S*) and one InfBench-Sum (the two gpt-4o judges), and one each from an AR
    document task, a TTL task and an SF task. Every competency is in it."""
    rng, by_task = random.Random(SMOKE_SEED), {}
    for q in qs:
        by_task.setdefault(q["task"], []).append(q)
    frames = (("lme",), ("infbench_sum",), ("sh_qa", "mh_qa", "eventqa"),
              tuple(t.key for t in TASKS if t.column in ("MCC", "Recom")), ("fc_sh", "fc_mh"))
    return [rng.choice(by_task[rng.choice(frame)])["qid"] for frame in frames]


def memories(out: Path, arm: str, qid: str) -> list[str]:
    """The chunks hippo returned, in rank order, as BM25's documents hold them; stops on an unhashed file."""
    raw = pred_path(out, arm, qid).read_bytes()
    if sha_bytes(raw) != json.loads((out / "predicted" / "manifest.json").read_text(encoding="utf-8"))[arm][qid]:
        sys.exit(f"predicted file for {arm} {qid} differs from its manifest")
    mems = [r["memory"] for r in json.loads(raw)["results"]]
    if any(not m.startswith(PREFIX) for m in mems):
        sys.exit(f"a memory of {qid} lacks the server's {PREFIX!r} prefix")
    return [m[len(PREFIX):] for m in mems]


def reader_user(mems: list[str], query: str) -> str:
    """agent.py:886-893: each memory with a trailing newline, labelled "Memory i:", joined by newlines, then the query."""
    retrieval_context = [f"{text}\n" for text in mems]
    retrieval_memory_string = "\n".join([f"Memory {i+1}:\n{text}" for i, text in enumerate(retrieval_context)])
    return retrieval_memory_string + "\n" + query


def answer_items(out: Path, arm: str, qs: list[dict]) -> dict[str, Item]:
    return {q["qid"]: Item(f"mab answer {arm} {q['qid']}", official.get_template(TASK[q["task"]].source, "system", AGENT),
                           reader_user(memories(out, arm, q["qid"]), q["query"]), manifest(answerer(TASK[q["task"]])))
            for q in qs}


def answer_log(out: Path, t: Task) -> Path:
    return out / f"calls-answer-g{t.gen}.jsonl"  # one log per settings, so one client writes each


def settled_answers(out: Path, arm: str, qs: list[dict]) -> dict:
    items, ledgers = answer_items(out, arm, qs), {}
    for q in qs:
        log = answer_log(out, TASK[q["task"]])
        ledgers.setdefault(log, Ledger(log))
    got = {q["qid"]: ledgers[answer_log(out, TASK[q["task"]])].choose(items[q["qid"]]) for q in qs}
    unsettled(got, "answers")
    return got


def judge_items(arm: str, q: dict, output: str) -> dict[str, Item]:
    """longmem_qa_evaluate.py:156 for LME(S*); summarization_evaluate.py:418-420 for InfBench-Sum; none otherwise."""
    tag = f"{arm} {q['qid']}"
    if q["task"] == "lme":
        prompt = official.get_anscheck_prompt(q["question_type"], q["raw_question"], q["answer"], output,
                                              abstention="_abs" in q["question_id"])
        return {"lme": Item(f"mab lme-judge {tag}", "", prompt, manifest(LME_JUDGE))}
    if q["task"] != "infbench_sum":
        return {}
    text = output.strip()
    keypoints = "\n".join([f"{i+1}. {kp}" for i, kp in enumerate(q["keypoints"])])
    prompts = {"fluency": official.fluency_prompt_book.format(text=text),
               "recall": official.recall_prompt_book.format(keypoints=keypoints, summary=text),
               "precision": official.precision_prompt_book.format(expert_summary=q["answer"][0], summary=text)}
    return {k: Item(f"mab sum-{k} {tag}", "", p, manifest(SUM_JUDGE)) for k, p in prompts.items()}


def judge_log(out: Path, kind: str) -> Path:
    return out / ("calls-judge-lme.jsonl" if kind == "lme" else "calls-judge-sum.jsonl")


def all_judges(out: Path, arm: str, qs: list[dict], answers: dict, settle=None, slots: int = 1) -> dict:
    todo = [(q["qid"], k, it) for q in qs if answers[q["qid"]].status == "valid"
            for k, it in judge_items(arm, q, answers[q["qid"]].value).items()]
    ledgers = {k: Ledger(judge_log(out, k)) for k in ("lme", "sum")}
    pick = settle or (lambda kind, it: ledgers["lme" if kind == "lme" else "sum"].choose(it))
    with ThreadPoolExecutor(slots) as pool:
        done = list(pool.map(lambda x: pick(x[1], x[2]), todo))
    return {(qid, kind): c for (qid, kind, _), c in zip(todo, done)}


def run_answers(out: Path, arm: str, qs: list[dict], slots: int) -> None:
    todo = answer_items(out, arm, qs)
    print(f"{arm}: {len(todo)} answers into {out}", flush=True)
    for gen in sorted({TASK[q["task"]].gen for q in qs}):
        group = [q for q in qs if TASK[q["task"]].gen == gen]
        log = answer_log(out, TASK[group[0]["task"]])
        ledger, llm = Ledger(log), OpenAIChat(log, answerer(TASK[group[0]["task"]]), slots=slots)
        require(llm, todo[group[0]["qid"]].manifest)
        with ThreadPoolExecutor(slots) as pool:
            list(pool.map(lambda q: ledger.settle(todo[q["qid"]], llm), group))


def run_judges(out: Path, arm: str, qs: list[dict], slots: int) -> None:
    answers = settled_answers(out, arm, qs)
    clients = {"lme": OpenAIChat(judge_log(out, "lme"), LME_JUDGE, slots=slots),
               "sum": OpenAIChat(judge_log(out, "sum"), SUM_JUDGE, slots=slots)}
    ledgers = {k: Ledger(judge_log(out, k)) for k in clients}

    def settle(kind: str, it: Item):
        k = "lme" if kind == "lme" else "sum"
        return ledgers[k].settle(it, clients[k])
    all_judges(out, arm, qs, answers, settle=settle, slots=slots)


def metric_value(q: dict, text: str) -> float:
    """post_process (eval_other_utils.py:450-476) and the README's key for the column."""
    t = TASK[q["task"]]
    with contextlib.chdir(DATA):  # _process_recsys_dataset reads ./processed_data/Recsys_Redial/entity2id.json
        m, _ = official.post_process({"output": text}, q["answer"], {"sub_dataset": t.source, "debug": False})
    return float(m[t.metric])


def summary_f1(replies: dict[str, str], q: dict) -> float | None:
    """summarization_evaluate.py:436-444; None where a reply holds no JSON, which the script leaves out."""
    f, r, p = (official.parse_json(replies[k]) for k in ("fluency", "recall", "precision"))
    if None in (f, r, p):
        return None
    rec = r["recall"] / len(q["keypoints"]) if len(q["keypoints"]) > 0 else 0
    prec = p["precision"] / p["sentence_count"] if p["sentence_count"] > 0 else 0
    return f["fluency"] * 2 * (rec * prec) / (rec + prec) if rec + prec > 0 else 0


def question_scores(qs: list[dict], answers: dict, judges: dict) -> tuple[dict, list[str]]:
    """Each question's score in 0..1. No valid answer scores 0; a judge with no usable reply leaves the question out,
    as the authors' judge scripts do."""
    got, out_of_mean = {}, []
    for q in qs:
        a = answers[q["qid"]]
        if a.status != "valid":
            got[q["qid"]] = 0.0
        elif q["task"] == "lme":
            j = judges.get((q["qid"], "lme"))
            got[q["qid"]] = float("yes" in j.value.strip().lower()) if j and j.status == "valid" else None
        elif q["task"] == "infbench_sum":
            js = {k: judges.get((q["qid"], k)) for k in ("fluency", "recall", "precision")}
            ok = all(j and j.status == "valid" for j in js.values())
            got[q["qid"]] = summary_f1({k: j.value for k, j in js.items()}, q) if ok else None
        else:
            got[q["qid"]] = metric_value(q, a.value)
        if got[q["qid"]] is None:
            out_of_mean.append(q["qid"])
    return got, out_of_mean


def table(qs: list[dict], scores: dict) -> dict[str, float]:
    """Table 3's columns: each task's mean x 100, MCC the mean of the five ICL means, then the averages."""
    means = {}
    for t in TASKS:
        vals = [scores[q["qid"]] for q in qs if q["task"] == t.key and scores[q["qid"]] is not None]
        if vals:
            means.setdefault(t.column, []).append(100 * statistics.fmean(vals))
    cols = {c: statistics.fmean(v) for c, v in means.items()}
    for comp, members in COMPETENCY.items():
        if all(m in cols for m in members):
            cols[f"{comp} avg"] = statistics.fmean(cols[m] for m in members)
    if all(f"{c} avg" in cols for c in COMPETENCY):
        cols["Overall"] = statistics.fmean(cols[f"{c} avg"] for c in COMPETENCY)
    return cols


def pool_tokens(choices) -> tuple[int, int]:
    use = [(c.record.get("usage") or {}) for c in choices if c.record]
    return sum(u.get("prompt_tokens") or 0 for u in use), sum(u.get("completion_tokens") or 0 for u in use)


def cost_lines(answers: dict, judges: dict, n: int) -> list[str]:
    (ain, aout), (jin, jout) = pool_tokens(answers.values()), pool_tokens(judges.values())
    return [f"tokens per question: small pool (gpt-4o-mini answers) {ain / n:.0f} in, {aout / n:.0f} out; "
            f"big pool (gpt-4o judges) {jin / n:.0f} in, {jout / n:.0f} out",
            *exhausted_lines(answers, "answers"), *exhausted_lines(judges, "judge checks")]


def write(path: Path, lines: list[str]) -> None:
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def score(out: Path, arm: str, qs: list[dict], smoke: bool, regime: str) -> None:
    answers = settled_answers(out, arm, qs)
    judges = all_judges(out, arm, qs, answers)
    unsettled(judges, "judge checks")
    n, valid = len(qs), sum(a.status == "valid" for a in answers.values())
    mems = statistics.fmean(len(memories(out, arm, q["qid"])) for q in qs)
    if smoke:
        per = []
        for q in qs:
            (ain, aout) = pool_tokens([answers[q["qid"]]])
            (jin, jout) = pool_tokens([c for (i, _), c in judges.items() if i == q["qid"]])
            per.append(f"  {q['qid']}: small {ain} in {aout} out; big {jin} in {jout} out")
        return write(out / "smoke.txt", [f"SMOKE {NAME}, {arm}, regime {regime}: integrity only, never scored or read",
                                         f"questions {n}, answers valid {valid}, judge checks {len(judges)} "
                                         f"(valid {sum(c.status == 'valid' for c in judges.values())}), "
                                         f"mean memories {mems:.2f}", *per, *cost_lines(answers, judges, n)])
    scores, left_out = question_scores(qs, answers, judges)
    primary = [q for q in qs if q["qid"] not in smoke_excluded("memoryagentbench", [q["qid"] for q in qs])]
    lines = [f"{NAME} as its authors' suite runs a memory method, {arm}, regime {regime}: top {TOPK}, {MINI} answers "
             f"at temperature 0.7, {FOUR_O} judges (HUST-AI-HYZ/MemoryAgentBench {PIN[:8]}, data {HF_REV[:8]})"]
    for name, sub in (("all questions", qs), ("primary", primary)):
        cols = table(sub, {q["qid"]: scores[q["qid"]] for q in sub})
        lines.append(f"{name} (n={len(sub)}): " + "; ".join(f"{k} {v:.1f}" for k, v in cols.items()))
    lines += [f"left out of a mean, as the judge scripts leave them: {len(left_out)} {left_out[:10]}",
              f"mean memories {mems:.2f}", *cost_lines(answers, judges, n)]
    write(out / "score.txt", lines)


def estimate(regime: str) -> None:
    """Prompt tokens a full run sends (o200k, framing counted as openai_llm counts it), each answer at 10 memories of
    its context's mean wrapped-chunk size, each judge with the answer at its cap; outputs at their caps. A ceiling:
    hippo may return fewer than 10 memories and replies run shorter than their caps."""
    import tiktoken
    enc = tiktoken.get_encoding("o200k_base")
    n = lambda text: len(enc.encode(text, disallowed_special=()))  # noqa: E731
    per_user = {}
    for user, turns in conversations():
        sizes = [n(t["content"]) for t in turns]
        per_user[user] = (statistics.fmean(sizes) + 6) * min(TOPK, len(sizes))  # + "Memory i:" and newlines
    frame = 2 * 8 + 16 + n(official.SYSTEM_MESSAGE)
    small_in = small_out = big_in = big_out = 0
    for q in questions():
        t = TASK[q["task"]]
        small_in += per_user[q["user_id"]] + n(q["query"]) + frame
        small_out += t.gen
        filler = "x " * t.gen  # the answer at its cap, about one token a word
        for it in judge_items("estimate", q, filler).values():
            big_in += n(it.user) + 8 + 16
            big_out += LME_JUDGE.max_tokens if q["task"] == "lme" else SUM_JUDGE.max_tokens
    print(f"regime {regime}: small pool {small_in / 1e6:.2f}M in, {small_out / 1e6:.3f}M out at caps; "
          f"big pool {big_in / 1e6:.3f}M in, {big_out / 1e6:.3f}M out at caps")


def setup(stage: str, out: Path, arm: str, smoke: bool, regime: str) -> list[dict]:
    """The questions asked, fixed at ingest in questions.json with the config."""
    qs = questions()
    if smoke:
        pick = smoke_pick(qs)
        qs = [q for q in qs if q["qid"] in pick]
    qfile = out / "questions.json"
    if stage == "ingest":
        if qfile.exists() and json.loads(qfile.read_text(encoding="utf-8"))["qids"] != [q["qid"] for q in qs]:
            sys.exit(f"{qfile} holds another question set; use a new folder")
        repo = HERE.parents[2]
        cfg = {"lane": "memoryagentbench, notes 2026-11-17", "name": NAME, "arm": arm, "regime": regime, "topk": TOPK,
               "chunk_sizes": {t.key: chunk_size(t, regime) for t in TASKS}, "smoke": smoke, "mab_commit": PIN,
               "hf_revision": HF_REV, "data": {**PARQUET_SHA, "entity2id.json": ENTITY_SHA,
                                              PREPARED.name: sha_bytes(PREPARED.read_bytes())},
               "hippo_memory": json.loads((repo / "package.json").read_text(encoding="utf-8"))["version"],
               "repo_head": subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True,
                                           text=True, check=True).stdout.strip(),
               "script_sha256": sha_bytes(Path(__file__).read_bytes()),
               "official_sha256": sha_bytes((HERE / "official.py").read_bytes()),
               "answerer": {t.key: answerer(t).cli for t in TASKS}, "judges": [LME_JUDGE.cli, SUM_JUDGE.cli]}
        out.mkdir(parents=True, exist_ok=True)
        qfile.write_text(json.dumps({"qids": [q["qid"] for q in qs]}), encoding="utf-8")
        (out / "config.json").write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    elif not qfile.exists() or json.loads(qfile.read_text(encoding="utf-8"))["qids"] != [q["qid"] for q in qs]:
        sys.exit(f"{qfile} is missing or holds another question set; run ingest with the same flags first")
    return qs


def main() -> None:
    global PREPARED
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("prepare", "ingest", "retrieve", "answer", "judge", "score", "estimate"))
    ap.add_argument("--regime", choices=("memory", "rag"), default="memory")
    ap.add_argument("--arm", choices=("hippo-emb", "bm25"), default="hippo-emb")
    ap.add_argument("--smoke", action="store_true", help="the five seeded smoke questions, into OUT/smoke/REGIME/ARM")
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--shards", type=int, default=1, help="ingest and retrieve: servers, each on its own contexts")
    ap.add_argument("--port-base", type=int, default=9401)
    a = ap.parse_args()
    PREPARED = DATA / f"prepared-{a.regime}.jsonl"
    if a.stage in ("prepare", "estimate"):
        return (prepare if a.stage == "prepare" else estimate)(a.regime)
    out = (OUT / "smoke" if a.smoke else OUT) / a.regime / a.arm
    if a.stage == "score":
        return score(out, a.arm, setup(a.stage, out, a.arm, a.smoke, a.regime), a.smoke, a.regime)
    with one_writer(out):
        qs = setup(a.stage, out, a.arm, a.smoke, a.regime)
        if a.stage in ("ingest", "retrieve"):
            ns = argparse.Namespace(out=out, arm=a.arm, arms={a.arm: SERVER_ARM[a.arm]}, store_from=None,
                                    shards=a.shards, port_base=a.port_base, stage=a.stage)
            harness.stage_ingest_retrieve(ns, sys.modules[__name__], qs)
        else:
            (run_answers if a.stage == "answer" else run_judges)(out, a.arm, qs, a.slots)


if __name__ == "__main__":
    main()
