#!/usr/bin/env python3
"""Merge sub-agent rerank outputs back into a retrieval JSONL.

Reads a baseline retrieval JSONL + a directory of per-batch rerank outputs.
For each question, reorders `retrieved_memories` to match the sub-agent's
`ranked_ids`. Memories not in `ranked_ids` are dropped; ids in `ranked_ids`
but not in `retrieved_memories` are dropped (the sub-agent shouldn't invent
ids, but be defensive).
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--retrieval", type=Path, required=True)
    p.add_argument("--ranks-dir", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()

    rank_map = {}
    for f in sorted(args.ranks_dir.glob("batch_*.json")):
        for entry in json.loads(f.read_text()):
            rank_map[entry["question_id"]] = entry["ranked_ids"]

    print(f"Loaded rerank for {len(rank_map)} questions", file=sys.stderr)

    n_written = 0
    n_missing = 0
    with open(args.retrieval) as f_in, open(args.out, "w") as f_out:
        for line in f_in:
            entry = json.loads(line)
            qid = entry["question_id"]
            if qid not in rank_map:
                n_missing += 1
                f_out.write(line)
                continue
            ranked = rank_map[qid]
            by_id = {m["id"]: m for m in entry.get("retrieved_memories", [])}
            new_mems = [by_id[i] for i in ranked if i in by_id]
            entry["retrieved_memories"] = new_mems
            entry["num_retrieved"] = len(new_mems)
            f_out.write(json.dumps(entry) + "\n")
            n_written += 1

    print(f"Wrote {n_written} reranked entries ({n_missing} kept as-is) to {args.out}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
