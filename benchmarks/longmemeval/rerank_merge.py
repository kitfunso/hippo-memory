#!/usr/bin/env python3
"""
rerank_merge.py — Merge rerank outputs into a reranked JSONL.

Reads:
  - results/f9_baseline/best.jsonl (original retrieval with full memory objects)
  - /tmp/rerank_outputs/batch_*.json (50 batch rerank outputs)

For each question:
  1. Looks up ranked_ids from the batch output.
  2. Reorders retrieved_memories to follow ranked_ids order.
  3. Writes to results/f9_rerank/best_reranked.jsonl.

Output JSONL has 500 lines, each preserving all original fields except
retrieved_memories (reordered per LLM-rerank output).
"""

import json
import os
import glob
from pathlib import Path

BASELINE_JSONL = Path(__file__).parent.parent.parent / "results" / "f9_baseline" / "best.jsonl"
RERANK_OUTPUT_DIR = Path("/tmp/rerank_outputs")
OUTPUT_DIR = Path(__file__).parent.parent.parent / "results" / "f9_rerank"
OUTPUT_JSONL = OUTPUT_DIR / "best_reranked.jsonl"


def load_rerank_outputs():
    """Load all rerank outputs into a dict: question_id -> ranked_ids list."""
    ranking_map = {}
    files = sorted(glob.glob(str(RERANK_OUTPUT_DIR / "batch_*.json")))
    print(f"Loading {len(files)} rerank output files...")
    for fpath in files:
        with open(fpath) as f:
            batch = json.load(f)
        for item in batch:
            ranking_map[item["question_id"]] = item["ranked_ids"]
    print(f"Loaded rankings for {len(ranking_map)} questions")
    return ranking_map


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    ranking_map = load_rerank_outputs()

    written = 0
    missing_ranking = []
    missing_memory = []

    with open(BASELINE_JSONL) as fin, open(OUTPUT_JSONL, "w") as fout:
        for line in fin:
            line = line.strip()
            if not line:
                continue

            entry = json.loads(line)
            question_id = entry["question_id"]

            if question_id not in ranking_map:
                missing_ranking.append(question_id)
                # Fall back to original order
                fout.write(json.dumps(entry) + "\n")
                written += 1
                continue

            ranked_ids = ranking_map[question_id]
            original_mems = entry.get("retrieved_memories", [])

            # Build lookup: mem_id -> memory object
            mem_by_id = {m["id"]: m for m in original_mems}

            # Reorder memories per ranked_ids
            reordered = []
            for mem_id in ranked_ids:
                if mem_id in mem_by_id:
                    reordered.append(mem_by_id[mem_id])
                else:
                    missing_memory.append((question_id, mem_id))

            # If some memories are missing from ranking (shouldn't happen), append them
            ranked_set = set(ranked_ids)
            for m in original_mems:
                if m["id"] not in ranked_set:
                    reordered.append(m)

            entry["retrieved_memories"] = reordered
            fout.write(json.dumps(entry) + "\n")
            written += 1

    print(f"\nWrote {written} lines to {OUTPUT_JSONL}")
    if missing_ranking:
        print(f"WARNING: {len(missing_ranking)} questions had no ranking (kept original order)")
    if missing_memory:
        print(f"WARNING: {len(missing_memory)} memory objects referenced in ranking but not found in baseline")
    print("Done.")


if __name__ == "__main__":
    main()
