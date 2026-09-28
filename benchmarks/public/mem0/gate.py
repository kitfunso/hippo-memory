"""The Mem0 arm's integrity gate (prereg Amendments 4 and 5), run before any answer; `h2h.py answer` refuses without it.

Prints GATE: PASS or GATE: FAIL and writes gate.json with a fingerprint of what it checked.
Usage, in Mem0's environment so replies parse with Mem0's own helpers: python gate.py --run SCRATCH_DIR [--ingest DIR]
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
UPSTREAM = re.compile(r'HTTP Request: (\w+) http://127\.0\.0\.1:(\d+)(/[^\s?"]*)\S* "HTTP/[\d.]+ (\d{3})')  # Mem0 to Qdrant, Ollama, proxy
SERVED = re.compile(r'"(\w+) (/[^ ?"]*)\S* HTTP/[\d.]+" (\d{3})')  # uvicorn's line for each request the runner made
# Failed requests Mem0 redoes piece by piece, where a failed piece logs WARNING or ERROR or fails the add: a batch
# embedding (Ollama), a batch search (qdrant.py:394-396) and a batch insert of memories (main.py:686-692).
REDONE = re.compile(r"\w+ 11434 /\S*|POST 6333 /collections/[^/]+/points/query/batch|PUT 6333 /collections/locomo_mem0/points")
RECOVERED = "Batch search failed, falling back to sequential"  # qdrant.py:395, the batch search in REDONE
QDRANT_BODY = "Raw response content:"  # qdrant_client puts an error's body on two more lines (exceptions.py:37-38)


def fingerprint(ingest: Path) -> dict:
    """Hashes of the logs and every predicted file, so a later change voids the gate."""
    pred = hashlib.sha256()
    for p in sorted((ingest / "predicted_locomo-mem0").glob("*.json")):
        pred.update(p.name.encode() + b"\0" + p.read_bytes())
    return {**{n: hashlib.sha256((ingest / n).read_bytes()).hexdigest() for n in LOGS}, "predicted": pred.hexdigest()}


def md5(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()  # Mem0's memory hash (main.py:649)


def stamp(date: str | None) -> str | None:
    """A session date as mem0_server.py stores it, parsed as the runner parses it (run.py:127-140)."""
    for fmt in ("%I:%M %p on %d %B, %Y", "%I:%M %p on %d %b, %Y"):
        try:
            when = datetime.strptime(date, fmt).replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue
        return when.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return None


def text_of(path: Path) -> str:
    return path.read_bytes().decode("utf-8", "replace")  # the server's console may not write UTF-8


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


def scroll(qdrant: str, collection: str, **body) -> list[dict]:
    out, offset = [], None
    while True:
        res = post(f"{qdrant}/collections/{collection}/points/scroll", {"limit": 1000, "offset": offset, **body})
        out += res["points"]
        offset = res.get("next_page_offset")
        if offset is None:
            return out


def points(qdrant: str) -> list[dict]:
    return scroll(qdrant, COLLECTION, with_vector=["bm25"],
                  with_payload=["user_id", "data", "text_lemmatized", "hash", "attributed_to", "created_at"])


def alarms_in(lines: list[str]) -> list[str]:
    """Lines holding an alarm word, less Mem0's recovery WARNING and the two body lines Qdrant's error text adds to it."""
    out, skip = [], 0
    for i, line in enumerate(lines):
        if skip:
            skip -= 1
        elif RECOVERED in line:
            body = [x.rstrip("\r") for x in lines[i + 1:i + 3]]
            skip = 2 if len(body) == 2 and body[0] == QDRANT_BODY and body[1].startswith(("b'", 'b"')) else 0
        elif ALARM.search(line):
            out.append(line)
    return out


def logs(ingest: Path, turns: int, asked: int) -> tuple[list[tuple[bool, str]], list[list]]:
    """The extraction, server and runner logs. Also returns the memories of each successful extraction call."""
    # records split on LF alone: a reply may hold U+2028 or U+0085, which str.splitlines() also splits on
    recs = [json.loads(line) for line in (ingest / "calls-extract.jsonl").read_bytes().split(b"\n") if line.strip()]
    events = Counter(r["event"] for r in recs)
    parsed = [parse_reply(r["text"]) for r in recs if r["event"] == "ok"]
    bad = [p for p in parsed if isinstance(p, str)]
    calls = [p for p in parsed if isinstance(p, list)]
    server = text_of(ingest / "server.log").split("\n")
    runner = re.split(r"[\r\n]+", text_of(ingest / "runner.log"))  # progress bars redraw with \r
    alarms = alarms_in(server) + alarms_in(runner)
    failed = [(f"{m[1]} {m[2]} {m[3]}", m[4]) for line in server if (m := UPSTREAM.search(line)) and m[4][0] != "2"]
    redone = Counter(req for req, _ in failed if REDONE.fullmatch(req))
    served = Counter(m.groups() for line in server if (m := SERVED.search(line)))
    refused = {" ".join(k): n for k, n in served.items() if not k[2].startswith("2")}
    adds, searches = served[("POST", "/memories", "200")], served[("POST", "/search", "200")]
    embeds = sum("an embedding inside a batch failed" in line for line in server)
    return [
        (events["fail"] == 0 and events["ok"] == turns, f"extraction calls: {dict(events)}; one ok call per turn needs {turns}"),
        (not bad, f"replies Mem0 would lose memories from: {len(bad)} {bad[:3]}; memories extracted "
                  f"{sum(map(len, calls))}, replies with none {calls.count([])}"),
        (not alarms, f"server and runner log WARNING/ERROR/Traceback lines: {len(alarms)} {alarms[:3]}; batch searches "
                     f"Mem0 redid one query at a time {sum(RECOVERED in line for line in server)}"),
        (sum(redone.values()) == len(failed),
         f"Mem0's requests answered other than 2xx that it does not redo: "
         f"{[f for f in failed if not REDONE.fullmatch(f[0])][:5]}; redone piece by piece {dict(redone)}; embeddings "
         f"that failed inside a batch {embeds}"),
        (not refused and adds == turns and searches == asked,
         f"runner requests the server answered: adds {adds} of {turns}, searches {searches} of {asked}, "
         f"other than 2xx {refused}"),
    ], calls


def questions(ingest: Path, data: list, users: dict, stored: dict) -> tuple[bool, str]:
    """Each question file holds the question LoCoMo asks under that name, searched as its conversation's user, and
    memories that user has stored, word for word and date for date."""
    asked = {f"conv{i}_q{j}": (i, qa) for i, c in enumerate(data) for j, qa in enumerate(c["qa"])
             if qa.get("category") in CATEGORIES}
    files = {p.stem: json.loads(p.read_text(encoding="utf-8"))
             for p in (ingest / "predicted_locomo-mem0").glob("conv*_q*.json")}

    def hits(q: dict) -> list:
        return (q.get("retrieval") or {}).get("search_results") or []

    def matches(qid: str, q: dict) -> bool:
        i, qa = asked[qid]
        return (q.get("question_id") == qid and q.get("conversation_idx") == i and q.get("category") == qa["category"]
                and q.get("question") == qa["question"] == (q.get("retrieval") or {}).get("search_query")
                and q.get("user_id") == users[i])

    def foreign(qid: str, q: dict) -> bool:
        return any((s := stored.get(h.get("id"))) is None or s.get("user_id") != users[asked[qid][0]]
                   or h.get("memory") != s.get("data") or h.get("created_at") != s.get("created_at") for h in hits(q))

    wrong = [qid for qid in sorted(files) if qid in asked and not matches(qid, files[qid])]
    alien = [qid for qid in sorted(files) if qid in asked and foreign(qid, files[qid])]
    extra, missing = sorted(set(files) - set(asked)), sorted(set(asked) - set(files))
    distinct = len(set(users.values()) - {None})
    n = sorted(len(hits(q)) for q in files.values()) or [0]
    return (len(asked) == QUESTIONS and not (wrong or alien or extra or missing) and distinct == len(data),
            f"question files: {len(files)} for {len(asked)} questions asked ({QUESTIONS} registered); missing "
            f"{missing[:5]}, not asked {extra[:5]}, not the question asked or not its user's search {wrong[:5]}, "
            f"a memory that user has not stored with that text and date {alien[:5]}; {distinct} distinct users for "
            f"{len(data)} conversations; memories per question min {n[0]}, median {n[len(n) // 2]}, max {n[-1]}, "
            f"questions with none {n.count(0)}")


def bm25_wrong(pts: list[dict]) -> int:
    """Memories whose stored BM25 terms are not the ones their text encodes to, encoded as qdrant.py:182-186 does at
    insert; fastembed gives some texts, such as punctuation, none."""
    from fastembed import SparseTextEmbedding
    encoder = SparseTextEmbedding(model_name="Qdrant/bm25")  # as qdrant.py:88 builds it, from the same model cache
    texts = [p["payload"].get("text_lemmatized") or p["payload"].get("data") or "" for p in pts]
    wrong = 0
    for p, e in zip(pts, encoder.embed(texts)):
        got = (p.get("vector") or {}).get("bm25") or {}
        have = dict(zip(got.get("indices") or [], got.get("values") or []))
        want = dict(zip(e.indices.tolist(), e.values.tolist()))
        wrong += have.keys() != want.keys() or any(abs(have[i] - v) > 1e-5 * max(1.0, abs(v)) for i, v in want.items())
    return wrong


def unlinked(qdrant: str, pts: list[dict]) -> int:
    """Memories with entities that no entity links. Mem0 updates a matched entity from its search result, so two names
    in one add that match the same entity keep only the second's new links (main.py:769-781), with no log."""
    linked = {i for e in scroll(qdrant, f"{COLLECTION}_entities", with_payload=["linked_memory_ids"])
              for i in e["payload"].get("linked_memory_ids") or []}
    bare = [p for p in pts if p["id"] not in linked]
    from mem0.utils.entity_extraction import extract_entities_batch  # as main.py:719 extracts them
    return sum(bool(e) for e in extract_entities_batch([p["payload"].get("data") or "" for p in bare]))


def store(qdrant: str, pts: list[dict], calls: list[list], users: dict, dates: dict) -> list[tuple[bool, str]]:
    """Qdrant against the replies: nothing stored that no reply gave, and nothing a reply gave lost without a log line."""
    pay = [p["payload"] for p in pts]
    bad_bm25 = bm25_wrong(pts)
    per_user = Counter(p.get("user_id") for p in pay)
    bad_hash = sum(p.get("hash") != md5(p.get("data") or "") for p in pay)
    stored = Counter(p.get("hash") for p in pay)
    extracted = Counter(md5(m["text"]) for c in calls for m in c)
    unexplained = stored - extracted  # stored more often than the replies gave it
    lost = [h for h in extracted if not stored[h]]
    holders, said_by, kept_by, turns_of = defaultdict(set), defaultdict(set), defaultdict(set), Counter()
    for c in calls:
        turns_of.update({md5(m["text"]) for m in c})
        for m in c:
            said_by[md5(m["text"])].add(str(m.get("attributed_to") or ""))
    for p in pay:
        holders[p.get("hash")].add(p.get("user_id"))
        kept_by[p.get("hash")].add(str(p.get("attributed_to") or ""))
    # Mem0 skips a text only when the same user holds a copy (main.py:634-652), so one user holds every text of a reply
    owners = [set.intersection(*(holders[md5(m["text"])] for m in c)) for c in calls if c]
    conv = {u: i for i, u in users.items()}
    undated = sum(p.get("created_at") not in dates.get(conv.get(p.get("user_id")), ()) for p in pay)
    miscredited = sum(str(p.get("attributed_to") or "") not in said_by[p.get("hash")] for p in pay)
    skipped = {h: n - stored[h] for h, n in extracted.items() if 0 < stored[h] < n}
    ents = {u: post(f"{qdrant}/collections/{COLLECTION}_entities/points/count", {
        "exact": True, "filter": {"must": [{"key": "user_id", "match": {"value": u}}]}})["count"]
        for u in sorted(set(users.values()) - {None})}
    return [
        (bad_bm25 == 0 and set(per_user) == set(users.values()) and not (bad_hash or unexplained or lost),
         f"stored memories: {len(pay)}, with BM25 terms other than those their text encodes to {bad_bm25}, hash not "
         f"of its text {bad_hash}; stored more often than extracted {sum(unexplained.values())}, extracted but never stored "
         f"{len(lost)}; per user {dict(sorted(per_user.items()))}"),
        (not (owners.count(set()) or undated or miscredited),
         f"per user: replies whose memories no one user holds {owners.count(set())}, memories not dated at a session "
         f"of their user's conversation {undated}, memories whose speaker no reply gave for that text {miscredited}; "
         f"replies whose memories more than one user holds {sum(len(o) > 1 for o in owners)}"),
        (bool(ents) and all(ents.values()), f"entity links per user: {ents}"),
        (True, f"info: Mem0 skipped {sum(skipped.values())} extracted copies of {len(skipped)} texts as duplicates of "
               f"a stored copy; {sum(turns_of[h] > 1 for h in skipped)} of those texts came from more than one turn, "
               f"so a later turn's date may be lost; {sum(bool(said_by[h] - kept_by[h]) for h in skipped)} lost an "
               f"attributed_to that no stored copy has; memories with entities that no entity links "
               f"{unlinked(qdrant, pts)}"),
    ]


def check(ingest: Path, qdrant: str) -> list[tuple[bool, str]]:
    data = json.loads(LOCOMO.read_text(encoding="utf-8"))
    sessions = [{k: v for k, v in c["conversation"].items() if re.fullmatch(r"session_\d+", k)} for c in data]
    turns = [sum(map(len, s.values())) for s in sessions]
    dates = {i: {stamp(c["conversation"].get(f"{k}_date_time")) for k in s} - {None}
             for i, (c, s) in enumerate(zip(data, sessions))}
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
    pts = points(qdrant)
    res.append(questions(ingest, data, users, {p["id"]: p["payload"] for p in pts}))
    return res + store(qdrant, pts, calls, users, dates)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--run", type=Path, required=True, help="scratch run dir holding ingest/")
    ap.add_argument("--qdrant", default="http://127.0.0.1:6333")
    ap.add_argument("--ingest", default="ingest", choices=("ingest", "ingest-fixed"),
                    help="the ingestion to check: ingest-fixed is the mem0-fixed arm's (Amendment 6)")
    a = ap.parse_args()
    ingest = a.run / a.ingest
    res = check(ingest, a.qdrant)
    ok = all(passed for passed, _ in res)
    lines = [f"{'ok  ' if passed else 'FAIL'} {text}" for passed, text in res] + [f"GATE: {'PASS' if ok else 'FAIL'}"]
    print("\n".join(lines))
    tmp = ingest / "gate.json.tmp"
    tmp.write_text(json.dumps({
        "pass": ok, "checked": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fingerprint": fingerprint(ingest), "lines": lines}, indent=1), encoding="utf-8")
    tmp.replace(ingest / "gate.json")  # whole or absent: a kill mid-write never leaves half a gate


if __name__ == "__main__":
    main()
