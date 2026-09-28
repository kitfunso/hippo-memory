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
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

LOCOMO = Path.home() / "hippo-bench" / "locomo" / "data" / "locomo10.json"
COLLECTION, QUESTIONS, CATEGORIES = "locomo_mem0", 1540, (1, 2, 3, 4)
LOGS = ("calls-extract.jsonl", "server.log", "runner.log")
# Mem0, the runner's client and mem0_server.py log every loss at WARNING or above
ALARM = re.compile(r"WARNING|ERROR|CRITICAL|Traceback|Warning|Exception")
UPSTREAM = re.compile(r'HTTP Request: \w+ http://127\.0\.0\.1:(\d+)\S* "HTTP/[\d.]+ (\d{3})')  # Mem0 to Qdrant, Ollama, proxy
SERVED = re.compile(r'"(\w+) (/[^ ?"]*)\S* HTTP/[\d.]+" (\d{3})')  # uvicorn's line for each request the runner made
OLLAMA = "11434"  # a failed batch embedding is redone one text at a time, and a text that still fails logs a WARNING


def fingerprint(ingest: Path) -> dict:
    """Hashes of the logs and every predicted file, so a later change voids the gate."""
    pred = hashlib.sha256()
    for p in sorted((ingest / "predicted_locomo-mem0").glob("*.json")):
        pred.update(p.name.encode() + b"\0" + p.read_bytes())
    return {**{n: hashlib.sha256((ingest / n).read_bytes()).hexdigest() for n in LOGS}, "predicted": pred.hexdigest()}


def md5(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()  # Mem0's memory hash (main.py:649)


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
    if any(not isinstance(m, dict) or not isinstance(m.get("text"), str) or not m["text"] for m in obj["memory"]):
        return f"a memory without text: {text[:120]!r}"
    return obj["memory"]


def post(url: str, body: dict) -> dict:
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))["result"]


def points(qdrant: str) -> list[dict]:
    out, offset = [], None
    while True:
        res = post(f"{qdrant}/collections/{COLLECTION}/points/scroll", {
            "limit": 1000, "with_payload": ["user_id", "data", "hash", "attributed_to"], "with_vector": ["bm25"],
            "offset": offset})
        out += res["points"]
        offset = res.get("next_page_offset")
        if offset is None:
            return out


def logs(ingest: Path, turns: int, asked: int) -> tuple[list[tuple[bool, str]], list[list]]:
    """The extraction, server and runner logs. Also returns the memories of each successful extraction call."""
    recs = [json.loads(line) for line in (ingest / "calls-extract.jsonl").read_text(encoding="utf-8").splitlines()]
    events = Counter(r["event"] for r in recs)
    parsed = [parse_reply(r["text"]) for r in recs if r["event"] == "ok"]
    bad = [p for p in parsed if isinstance(p, str)]
    calls = [p for p in parsed if isinstance(p, list)]
    server = (ingest / "server.log").read_text(encoding="utf-8").splitlines()
    runner = re.split(r"[\r\n]+", (ingest / "runner.log").read_text(encoding="utf-8"))  # progress bars redraw with \r
    alarms = [line for line in server + runner if ALARM.search(line)]
    upstream = [(m[1], m[2]) for line in server if (m := UPSTREAM.search(line)) and not m[2].startswith("2")]
    to_ollama = sum(port == OLLAMA for port, _ in upstream)
    served = Counter(m.groups() for line in server if (m := SERVED.search(line)))
    refused = {" ".join(k): n for k, n in served.items() if not k[2].startswith("2")}
    adds, searches = served[("POST", "/memories", "200")], served[("POST", "/search", "200")]
    redone = sum("an embedding inside a batch failed" in line for line in server)
    return [
        (events["fail"] == 0 and events["ok"] == turns, f"extraction calls: {dict(events)}; one ok call per turn needs {turns}"),
        (not bad, f"replies Mem0 would lose memories from: {len(bad)} {bad[:3]}; memories extracted "
                  f"{sum(map(len, calls))}, replies with none {calls.count([])}"),
        (not alarms, f"server and runner log WARNING/ERROR/Traceback lines: {len(alarms)} {alarms[:3]}"),
        (len(upstream) == to_ollama, f"Mem0's requests to Qdrant and the proxy answered other than 2xx: "
                                     f"{[u for u in upstream if u[0] != OLLAMA][:5]}; to Ollama {to_ollama}, "
                                     f"batch embeddings Mem0 redid one text at a time {redone}"),
        (not refused and adds == turns and searches == asked,
         f"runner requests the server answered: adds {adds} of {turns}, searches {searches} of {asked}, "
         f"other than 2xx {refused}"),
    ], calls


def questions(ingest: Path, data: list, users: dict) -> tuple[bool, str]:
    """Each question file holds the question LoCoMo asks under that name, searched as its conversation's user."""
    asked = {f"conv{i}_q{j}": (i, qa) for i, c in enumerate(data) for j, qa in enumerate(c["qa"])
             if qa.get("category") in CATEGORIES}
    files = {p.stem: json.loads(p.read_text(encoding="utf-8"))
             for p in (ingest / "predicted_locomo-mem0").glob("conv*_q*.json")}

    def matches(qid: str, q: dict) -> bool:
        i, qa = asked[qid]
        return (q.get("question_id") == qid and q.get("conversation_idx") == i and q.get("category") == qa["category"]
                and q.get("question") == qa["question"] == (q.get("retrieval") or {}).get("search_query")
                and q.get("user_id") == users[i])

    wrong = [qid for qid in sorted(files) if qid in asked and not matches(qid, files[qid])]
    extra, missing = sorted(set(files) - set(asked)), sorted(set(asked) - set(files))
    distinct = len(set(users.values()) - {None})
    hits = sorted(len((q.get("retrieval") or {}).get("search_results") or []) for q in files.values()) or [0]
    return (len(asked) == QUESTIONS and not (wrong or extra or missing) and distinct == len(data),
            f"question files: {len(files)} for {len(asked)} questions asked ({QUESTIONS} registered); missing "
            f"{missing[:5]}, not asked {extra[:5]}, not the question asked or not its user's search {wrong[:5]}; "
            f"{distinct} distinct users for {len(data)} conversations; memories per question min {hits[0]}, "
            f"median {hits[len(hits) // 2]}, max {hits[-1]}, questions with none {hits.count(0)}")


def store(qdrant: str, calls: list[list], users: dict) -> list[tuple[bool, str]]:
    """Qdrant against the replies: nothing stored that no reply gave, and nothing a reply gave lost without a log line."""
    pay = [(p["payload"], (p.get("vector") or {}).get("bm25") or {}) for p in points(qdrant)]
    no_bm25 = sum(not v.get("indices") for _, v in pay)
    per_user = Counter(p.get("user_id") for p, _ in pay)
    bad_hash = sum(p.get("hash") != md5(p.get("data") or "") for p, _ in pay)
    stored = Counter(p.get("hash") for p, _ in pay)
    extracted = Counter(md5(m["text"]) for c in calls for m in c)
    unexplained = stored - extracted  # stored more often than the replies gave it
    lost = [h for h in extracted if not stored[h]]  # Mem0 skips a text only when a copy of it is already stored
    said_by, kept_by, turns_of = defaultdict(set), defaultdict(set), Counter()
    for c in calls:
        turns_of.update({md5(m["text"]) for m in c})
        for m in c:
            said_by[md5(m["text"])].add(str(m.get("attributed_to") or ""))
    for p, _ in pay:
        kept_by[p.get("hash")].add(str(p.get("attributed_to") or ""))
    skipped = {h: n - stored[h] for h, n in extracted.items() if 0 < stored[h] < n}
    ents = {u: post(f"{qdrant}/collections/{COLLECTION}_entities/points/count", {
        "exact": True, "filter": {"must": [{"key": "user_id", "match": {"value": u}}]}})["count"]
        for u in sorted(set(users.values()) - {None})}
    return [
        (no_bm25 == 0 and set(per_user) == set(users.values()) and not (bad_hash or unexplained or lost),
         f"stored memories: {len(pay)}, without a BM25 vector {no_bm25}, hash not of its text {bad_hash}; stored more "
         f"often than extracted {sum(unexplained.values())}, extracted but never stored {len(lost)}; "
         f"per user {dict(sorted(per_user.items()))}"),
        (bool(ents) and all(ents.values()), f"entity links per user: {ents}"),
        (True, f"info: Mem0 skipped {sum(skipped.values())} extracted copies of {len(skipped)} texts as duplicates of "
               f"a stored copy; {sum(turns_of[h] > 1 for h in skipped)} of those texts came from more than one turn, "
               f"so a later turn's date may be lost; {sum(bool(said_by[h] - kept_by[h]) for h in skipped)} lost an "
               f"attributed_to that no stored copy has"),
    ]


def check(ingest: Path, qdrant: str) -> list[tuple[bool, str]]:
    data = json.loads(LOCOMO.read_text(encoding="utf-8"))
    turns = [sum(len(v) for k, v in c["conversation"].items() if re.fullmatch(r"session_\d+", k)) for c in data]
    asked = sum(qa.get("category") in CATEGORIES for c in data for qa in c["qa"])
    res, calls = logs(ingest, sum(turns), asked)
    users = {}
    for i, n in enumerate(turns):
        path = ingest / "predicted_locomo-mem0" / f"_ingestion_{i}.json"
        cp = json.loads(path.read_text()) if path.exists() else {}
        users[i] = cp.get("user_id")
        res.append((cp.get("total_chunks_failed") == 0 and cp.get("total_chunks_processed") == n,
                    f"conversation {i}: {cp.get('total_chunks_processed')} of {n} turns, "
                    f"{cp.get('total_chunks_failed')} failed, user {users[i]}"))
    res.append(questions(ingest, data, users))
    return res + store(qdrant, calls, users)


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
