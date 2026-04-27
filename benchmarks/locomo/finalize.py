"""Build the final results report from the incremental jsonl.

Used when the main run is stopped early; aggregates the per-QA rows that were
already written and produces the canonical results JSON.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

from run import (
    JUDGE_MODEL,
    JUDGE_PROMPT_TEMPLATE,
    JUDGE_PROMPT_ADVERSARIAL,
    aggregate,
    QAResult,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--incremental", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--hippo-version", type=str, default="0.31.0")
    parser.add_argument("--judge-model", type=str, default=JUDGE_MODEL)
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--budget", type=int, default=4000)
    parser.add_argument("--sample-per-conv", type=int, default=10)
    parser.add_argument("--convs", type=int, default=5)
    parser.add_argument("--note", type=str, default="")
    args = parser.parse_args()

    rows = []
    with open(args.incremental, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            d = json.loads(line)
            rows.append(QAResult(**d))

    # Figure out how many distinct conversations we covered
    covered = {r.conversation_id for r in rows}

    agg = aggregate(rows)
    report = {
        "benchmark": "LoCoMo (snap-research/locomo10)",
        "hippo_version": args.hippo_version,
        "judge_model": args.judge_model,
        "judge_prompt_template_standard": JUDGE_PROMPT_TEMPLATE,
        "judge_prompt_template_adversarial": JUDGE_PROMPT_ADVERSARIAL,
        "config": {
            "top_k": args.top_k,
            "budget": args.budget,
            "conversations_attempted": args.convs,
            "conversations_covered": sorted(covered),
            "num_conversations_covered": len(covered),
            "sample_per_conv_requested": args.sample_per_conv,
            "skip_adversarial": False,
        },
        "note": args.note,
        "aggregate": agg,
        "per_qa": [
            {
                "conversation_id": r.conversation_id,
                "qa_index": r.qa_index,
                "question": r.question,
                "expected_answer": r.expected_answer,
                "category": r.category,
                "category_name": r.category_name,
                "is_adversarial": r.is_adversarial,
                "top_k_memories": r.top_k_memories,
                "judge_verdict": r.judge_verdict,
                "score": r.score,
            }
            for r in rows
        ],
    }
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"Wrote {args.output}")
    print(json.dumps(agg, indent=2))


if __name__ == "__main__":
    main()
