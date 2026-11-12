"""LoCoMo retrieval for a search-time arm by replay (prereg Amendment 6 dated notes 9), no model calls.

Each sample question's saved query goes again to read-only servers on the kept hippo-emb store, and the results take
the Mem0 client's shape and order (mem0_client.py:282-304), as a runner retrieval would. Nothing is written unless:
  gate 1: with the hippo-emb flags the replay gives back every hippo-emb file's results exactly (same store, same search);
  gate 2: at 200 the arm shows the memories hippo-emb shows (MMR and the cross-encoder re-order only the first 100);
  gate 3: the arm's first 25 searches, run twice, agree.
Then writes predicted_locomo-<arm>/, retrieval-check.json and MANIFEST-locomo.sha256 (h2h's gate), once.
Usage: python -I replay_locomo.py --arm hippo-best [--port 8941]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent / "qa"), str(HERE.parent)]
from harness import Server
from server_arms import FLAGS

BENCH = Path.home() / "hippo-bench"
EMB = BENCH / "retrieval-emb-locomo"
STORE = BENCH / "stores-v3" / "locomo-hippo-emb"
SAMPLE = HERE.parent / "results" / "2026-09-25-lane-a" / "locomo" / "sample.json"
TOP_K = 200  # the runner's --top-k for every LoCoMo arm (retrieval-emb-locomo/run.sh)
BAD_LOG = re.compile(r"failed|error|traceback|exception|fell back", re.IGNORECASE)


def client_order(results: list[dict]) -> list[dict]:
    """The Mem0 OSS client's normalisation and its stable sort by score, highest first."""
    out = []
    for r in results:
        e = {"memory": r.get("memory", r.get("data", "")), "score": r.get("score", 0), "id": r.get("id", "")}
        for k in ("created_at", "updated_at"):
            if r.get(k):
                e[k] = r[k]
        out.append(e)
    out.sort(key=lambda x: x.get("score", 0), reverse=True)
    return out


def shown(results: list[dict]) -> list:
    return sorted((r["memory"], r.get("created_at")) for r in results)


def search(srv, rec: dict) -> tuple[list[dict], float]:
    t = time.perf_counter()
    res = srv.call("POST", "/search", {"query": rec["retrieval"]["search_query"], "user_id": rec["user_id"],
                                       "limit": TOP_K})["results"]
    return client_order(res), round(1000 * (time.perf_counter() - t), 1)


def replay(qids: list[str], saved: dict[str, dict], base, arm) -> tuple[dict[str, dict], list[str], dict]:
    """The arm's files by question, the gate problems, and the counts each gate passed."""
    files, off1, off2, off3 = {}, [], [], []
    for n, qid in enumerate(qids):
        rec = saved[qid]
        if search(base, rec)[0] != rec["retrieval"]["search_results"]:
            off1.append(qid)
        got, ms = search(arm, rec)
        if shown(got) != shown(rec["retrieval"]["search_results"]):
            off2.append(qid)
        if n < 25 and search(arm, rec)[0] != got:
            off3.append(qid)
        files[qid] = {**rec, "retrieval": {"search_query": rec["retrieval"]["search_query"], "search_results": got,
                                           "search_latency_ms": ms, "total_results": len(got)}}
    problems = [f"gate {g}: {len(off)} questions, e.g. {off[0]} ({what})" for g, off, what in (
        (1, off1, "the hippo-emb replay differs from the saved file"), (2, off2, "other memories at 200 than hippo-emb"),
        (3, off3, "a second search differs")) if off]
    return files, problems, {"gate1_same": len(qids) - len(off1), "gate2_same": len(qids) - len(off2),
                             "gate3_same": min(25, len(qids)) - len(off3)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--arm", required=True, choices=sorted(set(FLAGS) - {"hippo-emb"}))
    ap.add_argument("--port", type=int, default=8941, help="the arm's server; the hippo-emb server takes port + 1")
    a = ap.parse_args()
    out = BENCH / f"retrieval-{a.arm.removeprefix('hippo-')}-locomo"
    if (out / "MANIFEST-locomo.sha256").exists():
        sys.exit(f"{out} has a manifest: it is written once")
    out.mkdir(parents=True, exist_ok=True)
    qids = json.loads(SAMPLE.read_text(encoding="utf-8"))
    pred = EMB / "predicted_locomo-hippo-emb"
    saved = {q: json.loads((pred / f"{q}.json").read_text(encoding="utf-8")) for q in qids}
    started = time.time()
    logs = {name: out / f"server-{name}.log" for name in ("hippo-emb", a.arm)}
    with Server(a.arm, a.port, STORE, logs[a.arm], True) as arm, Server("hippo-emb", a.port + 1, STORE, logs["hippo-emb"],
                                                                          True) as base:
        files, problems, counts = replay(qids, saved, base, arm)
    bad = [ln for p in logs.values() for ln in p.read_text(encoding="utf-8", errors="replace").splitlines()
           if BAD_LOG.search(ln) and "ExperimentalWarning" not in ln]
    if bad:
        problems.append(f"{len(bad)} server log lines name a failure, e.g. {bad[0][:200]}")
    res = {"pass": not problems, "problems": problems, "questions": len(qids), **counts, "store": str(STORE),
           "seconds": round(time.time() - started, 1)}
    (out / "retrieval-check.json").write_text(json.dumps(res, indent=1), encoding="utf-8")
    if problems:
        sys.exit("FAIL, nothing written: " + "; ".join(problems))
    d = out / f"predicted_locomo-{a.arm}"
    d.mkdir(exist_ok=True)
    for qid, rec in files.items():
        (d / f"{qid}.json").write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
    (out / "MANIFEST-locomo.sha256").write_text("".join(
        f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {d.name}/{p.name}\n" for p in sorted(d.glob("*.json"))),
        encoding="utf-8", newline="\n")
    print(f"PASS: {json.dumps(res)}")


if __name__ == "__main__":
    main()
