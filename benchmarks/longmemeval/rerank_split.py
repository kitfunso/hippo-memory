#!/usr/bin/env python3
"""
rerank_split.py — Split baseline retrieval JSONL into rerank batches.

Reads results/f9_baseline/best.jsonl (500 queries, each with retrieved_memories).
Writes /tmp/rerank_batches/batch_NNN.json (batches of 10 queries).
Candidate content is truncated to 600 chars.
"""

import json
import os
import sys
from pathlib import Path

BASELINE_JSONL = Path(__file__).parent.parent.parent / "results" / "f9_baseline" / "best.jsonl"
OUTPUT_DIR = Path("/tmp/rerank_batches")
BATCH_SIZE = 10
CONTENT_TRUNCATE = 600


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    queries = []
    with open(BASELINE_JSONL) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            candidates = []
            for mem in d.get("retrieved_memories", []):
                content = mem.get("content", "")
                candidates.append({
                    "id": mem["id"],
                    "content": content[:CONTENT_TRUNCATE],
                })
            queries.append({
                "question_id": d["question_id"],
                "question": d["question"],
                "candidates": candidates,
            })

    total = len(queries)
    print(f"Loaded {total} queries from {BASELINE_JSONL}")

    batch_num = 0
    for start in range(0, total, BATCH_SIZE):
        batch = queries[start:start + BATCH_SIZE]
        out_path = OUTPUT_DIR / f"batch_{batch_num:03d}.json"
        with open(out_path, "w") as f:
            json.dump(batch, f, indent=2)
        print(f"  Wrote {out_path.name}: {len(batch)} queries")
        batch_num += 1

    print(f"\nTotal batches: {batch_num}")
    print(f"Total queries: {total}")
    print(f"Output dir: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
