#!/usr/bin/env python3
"""Split a retrieval JSONL into per-batch input JSONs for sub-agent reranking.

Each batch is 10 queries; each query carries up to N candidates (default 20)
with content truncated to ~600 chars. Output: /tmp/rerank_batches_v2/batch_NNN.json.
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--retrieval", type=Path, required=True)
    p.add_argument("--out-dir", type=Path, required=True)
    p.add_argument("--batch-size", type=int, default=10)
    p.add_argument("--max-candidates", type=int, default=20)
    p.add_argument("--content-chars", type=int, default=600)
    args = p.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    queries = []
    with open(args.retrieval) as f:
        for line in f:
            entry = json.loads(line)
            cands = entry.get("retrieved_memories", [])[: args.max_candidates]
            queries.append({
                "question_id": entry["question_id"],
                "question": entry.get("question", ""),
                "candidates": [
                    {"id": c["id"], "content": (c.get("content") or "")[: args.content_chars]}
                    for c in cands
                ],
            })

    total = 0
    for i in range(0, len(queries), args.batch_size):
        batch = queries[i : i + args.batch_size]
        out = args.out_dir / f"batch_{i // args.batch_size:03d}.json"
        out.write_text(json.dumps(batch, indent=2))
        total += len(batch)
    print(f"Wrote {(len(queries) + args.batch_size - 1) // args.batch_size} batches "
          f"({total} queries) to {args.out_dir}", file=sys.stderr)


if __name__ == "__main__":
    main()
