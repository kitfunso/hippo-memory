"""Strict cross-check for evaluate_retrieval.py: exact session-id match, any/all, 500 vs 470 (no _abs).

usage: python score_haystack.py <data.json> <ret.jsonl> [<ret.jsonl> ...]
"""
import json
import sys
from pathlib import Path

data = {e["question_id"]: e for e in json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))}


def pct(hits: int, n: int) -> str:
    return f"{100 * hits / n:5.1f}"


for path in sys.argv[2:]:
    rows = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    outside = sum(
        m["tags"][0] not in set(data[r["question_id"]]["haystack_session_ids"])
        for r in rows for m in r["retrieved_memories"]
    )
    print(f"\n{Path(path).name}: {len(rows)} rows, {outside} retrieved ids outside their own haystack")
    for label, keep in (("all 500", lambda q: True), ("no _abs", lambda q: "_abs" not in q)):
        sub = [r for r in rows if keep(r["question_id"])]
        cells = []
        for k in (1, 3, 5, 10):
            loose = strict = every = 0
            for r in sub:
                gold = data[r["question_id"]]["answer_session_ids"]
                top = [m["tags"][0] for m in r["retrieved_memories"][:k]]
                loose += any(g in t for g in gold for t in top)
                strict += any(g in top for g in gold)
                every += all(g in top for g in gold)
            cells.append(f"R@{k} loose {pct(loose, len(sub))} strict {pct(strict, len(sub))} all {pct(every, len(sub))}")
        print(f"  {label} (n={len(sub)}): " + " | ".join(cells))
