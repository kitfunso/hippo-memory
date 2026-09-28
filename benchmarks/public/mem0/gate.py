"""The Mem0 arm's integrity gate (prereg Amendments 4 and 5), run before any answer; `h2h.py answer` refuses without it.

Prints GATE: PASS or GATE: FAIL and writes gate.json with a fingerprint of what it checked.
Usage, in Mem0's environment so replies parse with Mem0's own helpers: python gate.py --run SCRATCH_DIR
"""
from __future__ import annotations

import os

os.environ.setdefault("MEM0_TELEMETRY", "False")  # read when mem0 is imported

import argparse
import hashlib
import json
import re
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

LOCOMO = Path("C:/Users/skf_s/hippo-bench/locomo/data/locomo10.json")
COLLECTION, QUESTIONS = "locomo_mem0", 1540
ALARM = re.compile(r"WARNING|ERROR|CRITICAL|Traceback|Warning|Exception")  # Mem0 logs each failed add step at WARNING or ERROR


def fingerprint(ingest: Path) -> dict:
    """Hashes of the extraction log, the server log and every predicted file, so a later change voids the gate."""
    pred = hashlib.sha256()
    for p in sorted((ingest / "predicted_locomo-mem0").glob("*.json")):
        pred.update(p.name.encode() + b"\0" + p.read_bytes())
    files = {n: hashlib.sha256((ingest / n).read_bytes()).hexdigest() for n in ("calls-extract.jsonl", "server.log")}
    return {**files, "predicted": pred.hexdigest()}


def parse_reply(text: str) -> list | str:
    """The memories Mem0 takes from an extraction reply (main.py:601-622), or why it would lose some or all of them."""
    from mem0.memory.utils import extract_json, remove_code_blocks
    t = remove_code_blocks(text)
    try:
        try:
            obj = json.loads(t, strict=False)
        except json.JSONDecodeError:
            obj = json.loads(extract_json(t), strict=False)
    except json.JSONDecodeError:
        return f"not JSON: {text[:120]!r}"
    if not isinstance(obj, dict) or not isinstance(obj.get("memory"), list):
        return f"no `memory` list: {text[:120]!r}"
    if any(not isinstance(m, dict) or not m.get("text") for m in obj["memory"]):
        return f"a memory without text: {text[:120]!r}"
    return obj["memory"]


def points(qdrant: str) -> list[dict]:
    out, offset = [], None
    while True:
        body = {"limit": 1000, "with_payload": ["user_id"], "with_vector": ["bm25"], "offset": offset}
        req = urllib.request.Request(f"{qdrant}/collections/{COLLECTION}/points/scroll", json.dumps(body).encode(),
                                     {"Content-Type": "application/json"})
        res = json.load(urllib.request.urlopen(req))["result"]
        out += res["points"]
        offset = res.get("next_page_offset")
        if offset is None:
            return out


def check(ingest: Path, qdrant: str) -> list[tuple[bool, str]]:
    turns = [sum(len(v) for k, v in c["conversation"].items() if re.fullmatch(r"session_\d+", k))
             for c in json.loads(LOCOMO.read_text(encoding="utf-8"))]
    recs = [json.loads(line) for line in (ingest / "calls-extract.jsonl").read_text(encoding="utf-8").splitlines()]
    events = Counter(r["event"] for r in recs)
    parsed = [parse_reply(r["text"]) for r in recs if r["event"] == "ok"]
    bad = [p for p in parsed if isinstance(p, str)]
    alarms = [line for line in (ingest / "server.log").read_text(encoding="utf-8").splitlines() if ALARM.search(line)]
    res = [(events["fail"] == 0 and events["ok"] == sum(turns),
            f"extraction calls: {dict(events)}; one ok call per turn needs {sum(turns)}"),
           (not bad, f"replies Mem0 would lose memories from: {len(bad)} {bad[:3]}; memories extracted "
                     f"{sum(len(p) for p in parsed if isinstance(p, list))}, replies with none {parsed.count([])}"),
           (not alarms, f"server log WARNING/ERROR/Traceback lines: {len(alarms)} {alarms[:3]}")]
    users = {}
    for i, n in enumerate(turns):
        path = ingest / "predicted_locomo-mem0" / f"_ingestion_{i}.json"
        cp = json.loads(path.read_text()) if path.exists() else {}
        users[i] = cp.get("user_id")
        res.append((cp.get("total_chunks_failed") == 0 and cp.get("total_chunks_processed") == n,
                    f"conversation {i}: {cp.get('total_chunks_processed')} of {n} turns, "
                    f"{cp.get('total_chunks_failed')} failed, user {users[i]}"))
    qfiles = sorted((ingest / "predicted_locomo-mem0").glob("conv*_q*.json"))
    qs = [json.loads(p.read_text(encoding="utf-8")) for p in qfiles]
    wrong_user = [q["question_id"] for q in qs if q["user_id"] != users.get(q["conversation_idx"])]
    hits = sorted(len(q["retrieval"]["search_results"]) for q in qs) or [0]
    res.append((len(qs) == QUESTIONS and not wrong_user,
                f"question files: {len(qs)} of {QUESTIONS}; searched another user: {wrong_user[:5]}; "
                f"memories per question min {hits[0]}, median {hits[len(hits) // 2]}, max {hits[-1]}"))
    pts = points(qdrant)
    no_bm25 = sum(not (p.get("vector") or {}).get("bm25", {}).get("indices") for p in pts)
    per_user = Counter(p["payload"].get("user_id") for p in pts)
    res.append((no_bm25 == 0 and set(per_user) == set(users.values()),
                f"stored memories: {len(pts)}, without a BM25 vector: {no_bm25}, per user: {dict(sorted(per_user.items()))}"))
    return res


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--run", type=Path, required=True, help="scratch run dir holding ingest/")
    ap.add_argument("--qdrant", default="http://127.0.0.1:6333")
    a = ap.parse_args()
    ingest = a.run / "ingest"
    res = check(ingest, a.qdrant)
    ok = all(passed for passed, _ in res)
    lines = [f"{'ok  ' if passed else 'FAIL'} {text}" for passed, text in res] + [f"GATE: {'PASS' if ok else 'FAIL'}"]
    print("\n".join(lines))
    (ingest / "gate.json").write_text(json.dumps({
        "pass": ok, "checked": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fingerprint": fingerprint(ingest), "lines": lines}, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
