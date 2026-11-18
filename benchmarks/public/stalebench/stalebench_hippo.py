"""StaleBench (arXiv 2611.19752) Table 5, its systems track, over hippo's retrieval
(docs/evals/notes-2026-11-17-stalebench.md).

thenexuslab/stalebench-release 724fccc1, imported by stale_vendor.py: the 150-fact test subsample (p=0.5) in its anchored
and anchor-free configs, streamed in t order into one hippo store per config, each statement dated as Graphiti's
wrapper dates it (systems.statement_time); each value-agnostic query searched at the systems' depth of 20; scored as
Table 5 scores a system: current@1 by attribution, current@1 by text, contamination@5 by text, and qwen2.5:14b
answering from the top 5 (reader.build_prompt, greedy, 32 tokens, OllamaClient's request). No judge; gold is the
Wikidata validity year. No competitor arm runs.
Usage (runner venv): python -I stalebench_hippo.py {ingest,retrieve,read,score,reader-check} [--arm hippo-emb|bm25]
  [--smoke] [--undated] [--threads 4] [--shards 1] [--port-base 9701]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]
import stale_vendor as v  # noqa: E402
from qa import harness  # noqa: E402
from qa.harness import pred_path, sha_bytes  # noqa: E402
from qa.ledger import one_writer, smoke_excluded  # noqa: E402
from server_arms import SERVER_ARM  # noqa: E402

NAME = "StaleBench"
TOPK = v.DEPTH  # the harness searches with mod.TOPK
OUT = Path.home() / "hippo-bench" / "results-r2" / "stalebench"
SMOKE = ("anchored-q000", "anchored-q075", "anchored-q149", "anchor_free-q000", "anchor_free-q075")
COLUMNS = (("current@1", "cur@1"), ("current@1_text", "by text"), ("contamination@5_text", "cont.@5"),
           ("correct", "reader"))  # Table 5's four cells per block, in its order


class Run:
    smoke: bool = False
    dated: bool = True  # --undated: no date sent, so hippo dates each statement by the wall clock, as Mem0 does


def stamp(t: float) -> int:
    return int(v.module("systems").statement_time(t).timestamp())


def conversations():
    for c in v.CONFIGS:
        yield f"stalebench-{c}", [{"role": "user", "content": e["text"], "timestamp": stamp(e["t"]) if Run.dated else None}
                                  for e in v.subsample(c)["events"]]


def questions() -> list[dict]:
    return [{"qid": q["qid"], "user_id": f"stalebench-{c}", "question": q["question"], "ask_after": None, "config": c,
             "i": i} for c in v.CONFIGS for i, q in enumerate(v.subsample(c)["queries"])
            if not Run.smoke or q["qid"] in SMOKE]


def hits(out: Path, arm: str, qid: str) -> list[dict]:
    raw = pred_path(out, arm, qid).read_bytes()
    if sha_bytes(raw) != json.loads((out / "predicted" / "manifest.json").read_text(encoding="utf-8"))[arm][qid]:
        sys.exit(f"predicted file for {arm} {qid} differs from its manifest")
    return json.loads(raw)["results"]


def attributed(config: str, found: list[dict]) -> list[dict]:
    """Each hit as the statement it stores: hippo keeps the statement verbatim under the server's "user: " label, so the
    id is the statement with that text (and, when dated, that date); twin texts of one fact share a value."""
    by_text: dict[str, list[dict]] = {}
    for e in v.subsample(config)["events"]:
        by_text.setdefault(e["text"], []).append(e)
    used, out = set(), []
    for h in found:
        text = h["memory"].removeprefix("user: ")
        if not h["memory"].startswith("user: ") or text not in by_text:
            raise RuntimeError(f"{config}: hippo returned {h['memory'][:80]!r}, no statement of the stream")
        when = h["created_at"][:19]
        pick = [e for e in by_text[text] if e["sid"] not in used and (not Run.dated or iso(e["t"]) == when)]
        if not pick:
            raise RuntimeError(f"{config}: no unused statement for {text!r} at {when}")
        used.add(pick[0]["sid"])
        out.append({"sid": pick[0]["sid"], "text": text, "created_at": h["created_at"]})
    return out


def iso(t: float) -> str:
    return v.module("systems").statement_time(t).strftime("%Y-%m-%dT%H:%M:%S")


def contexts(out: Path, arm: str, qs: list[dict]) -> dict[str, list[dict]]:
    return {q["qid"]: attributed(q["config"], hits(out, arm, q["qid"])) for q in qs}


def prompt_of(q: dict, ctx: list[dict]) -> str:
    """run_sysreader's as_is arm: the system's top 5, no dates surfaced."""
    return v.module("reader").build_prompt([h["text"] for h in ctx[:v.READ_K]], q["question"])


def run_read(out: Path, arm: str, qs: list[dict], threads: int) -> None:
    client, ctx = v.ollama_client(out / "llm_cache", threads), contexts(out, arm, qs)
    for n, q in enumerate(qs, 1):
        client.generate(prompt_of(q, ctx[q["qid"]]), v.MAX_TOKENS)
        if n % 10 == 0 or n == len(qs):
            print(f"read {n}/{len(qs)} ({client.n_calls} asked, {client.n_cached} cached)", flush=True)


def records(out: Path, arm: str, qs: list[dict]) -> dict[str, dict]:
    """Each query scored as run_systems._score and run_sysreader score it; the reader answer comes from the cache only,
    so a missing answer stops the score."""
    os.environ["STALEBENCH_LLM_CACHE_ONLY"] = "1"
    m, rd = v.module("metrics"), v.module("reader")
    client, ctx, out_recs = v.ollama_client(out / "llm_cache", 1), contexts(out, arm, qs), {}
    for q in qs:
        lab, hs = v.subsample(q["config"])["queries"][q["i"]], ctx[q["qid"]]
        ranked = list(dict.fromkeys(h["sid"] for h in hs))
        rec = m.score_ranking(ranked, lab["fact"], lab["current"], (5,))
        rec.update(m.score_texts([h["text"] for h in hs], lab["gold"], lab["stale"], (5,)))
        rec.update(rd.score_answer(client.generate(prompt_of(q, hs), v.MAX_TOKENS), lab["gold"], lab["stale"]))
        out_recs[q["qid"]] = rec
    return out_recs


def score(out: Path, arm: str, qs: list[dict]) -> None:
    recs = records(out, arm, qs)
    label = "dated as Graphiti's wrapper dates them" if Run.dated else "undated"
    if Run.smoke:
        lines = [f"SMOKE {NAME}, {arm}: integrity only, never scored or read",
                 f"queries {len(qs)}, each with {v.READ_K}+ attributed hits and a cached reader answer"]
    else:
        every, lines = [q["qid"] for q in qs], [f"{NAME} Table 5, {arm}, statements {label}: depth {TOPK}, reader "
                                                 f"{v.READER} on the top {v.READ_K} (stalebench {v.COMMIT[:8]})"]
        primary = set(every) - smoke_excluded("stalebench", every)
        for c in v.CONFIGS:
            for name, ids in (("all items", [i for i in every if i.startswith(c + "-")]),
                              ("primary", [i for i in every if i.startswith(c + "-") and i in primary])):
                cells = "  ".join(f"{h} {sum(recs[i][k] for i in ids) / len(ids):.3f}" for k, h in COLUMNS)
                extra = "  ".join(f"{k} {sum(recs[i][k] for i in ids) / len(ids):.3f}"
                                  for k in ("contamination@5", "stale_rate", "hedged@1_text", "stale", "hedged"))
                lines.append(f"{c:<11} {name:<9} n={len(ids):<3} {cells}   ({extra})")
    (out / ("smoke.txt" if Run.smoke else "score.txt")).write_text("\n".join(lines) + "\n", encoding="utf-8")
    (out / "records.json").write_text(json.dumps(recs, indent=0), encoding="utf-8")
    print("\n".join(lines))


def reader_check(base: Path, threads: int, configs: list[str]) -> None:
    """The paper's cosine store-all top-5 prompts (its own sidecar), asked of this box's reader: answers equal to the
    paper's cached ones, and the reader cell each gives, against Table 5's cosine row."""
    rd, cache = v.module("reader"), v.paper_cache()
    client, lines = v.ollama_client(base / "reader-check" / "llm_cache", threads), []
    for c in configs:
        same = ours = paper = 0
        qs = v.subsample(c)["queries"]
        for n, (q, h) in enumerate(zip(qs, v.sidecar()["by_config"][c]["cosine-rag"]), 1):
            p = rd.build_prompt([x.get("text") or "" for x in h[:v.READ_K]], q["question"])
            theirs, mine = cache[v.cache_key(v.READER, p)]["text"], client.generate(p, v.MAX_TOKENS)
            same += theirs == mine
            ours += rd.score_answer(mine, q["gold"], q["stale"])["correct"]
            paper += rd.score_answer(theirs, q["gold"], q["stale"])["correct"]
            if n % 25 == 0:
                print(f"{c} {n}/{len(qs)}: {same} equal", flush=True)
        lines.append(f"{c}: cosine store-all top-5 prompts {len(qs)}, answers equal to the paper's cache {same}, "
                     f"reader {ours / len(qs):.3f} here against {paper / len(qs):.3f} from the cache")
    (base / "reader-check" / "check.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def setup(stage: str, out: Path, arm: str) -> list[dict]:
    qs, qfile = questions(), out / "questions.json"
    if stage == "ingest":
        if qfile.exists() and json.loads(qfile.read_text(encoding="utf-8"))["qids"] != [q["qid"] for q in qs]:
            sys.exit(f"{qfile} holds another question set; use a new folder")
        if bad := [d for c in v.CONFIGS for d in v.sidecar_drift(c)]:
            sys.exit(f"the rebuilt subsample differs from the paper's sidecar: {bad[:3]}")
        repo = HERE.parents[2]
        cfg = {"lane": "stalebench, notes-2026-11-17-stalebench.md", "arm": arm, "topk": TOPK, "smoke": Run.smoke,
               "dated": Run.dated, "commit": v.COMMIT, "blobs": v.BLOBS, "reader": v.READER,
               "hippo_memory": json.loads((repo / "package.json").read_text(encoding="utf-8"))["version"],
               "repo_head": subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True,
                                           text=True, check=True).stdout.strip(),
               "script_sha256": sha_bytes(Path(__file__).read_bytes()),
               "vendor_sha256": sha_bytes((HERE / "stale_vendor.py").read_bytes())}
        out.mkdir(parents=True, exist_ok=True)
        qfile.write_text(json.dumps({"qids": [q["qid"] for q in qs]}), encoding="utf-8")
        (out / "config.json").write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    elif not qfile.exists() or json.loads(qfile.read_text(encoding="utf-8"))["qids"] != [q["qid"] for q in qs]:
        sys.exit(f"{qfile} is missing or holds another question set; run ingest first")
    return qs


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("ingest", "retrieve", "read", "score", "reader-check"))
    ap.add_argument("--arm", choices=("hippo-emb", "bm25"), default="hippo-emb")
    ap.add_argument("--smoke", action="store_true", help=f"queries {SMOKE} over the whole 150-fact streams")
    ap.add_argument("--undated", action="store_true", help="secondary: send no statement dates")
    ap.add_argument("--threads", type=int, default=4, help="ollama num_thread for the reader")
    ap.add_argument("--check-configs", nargs="+", choices=v.CONFIGS, default=list(v.CONFIGS))
    ap.add_argument("--shards", type=int, default=1)
    ap.add_argument("--port-base", type=int, default=9701)
    a = ap.parse_args()
    Run.smoke, Run.dated = a.smoke, not a.undated
    base = OUT / "smoke" if a.smoke else OUT
    out = base / (a.arm + ("-undated" if a.undated else ""))
    if a.stage == "reader-check":
        with one_writer(OUT / "reader-check"):
            return reader_check(OUT, a.threads, a.check_configs)
    if a.stage == "score":
        return score(out, a.arm, setup(a.stage, out, a.arm))
    with one_writer(out):
        qs = setup(a.stage, out, a.arm)
        if a.stage in ("ingest", "retrieve"):
            ns = argparse.Namespace(out=out, arm=a.arm, arms={a.arm: SERVER_ARM[a.arm]}, store_from=None,
                                    shards=a.shards, port_base=a.port_base, stage=a.stage)
            harness.stage_ingest_retrieve(ns, sys.modules[__name__], qs)
        else:
            run_read(out, a.arm, qs, a.threads)


if __name__ == "__main__":
    main()
