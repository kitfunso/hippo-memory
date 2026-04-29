"""Analyze LoCoMo result JSONs without running retrieval or judge calls."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "for",
    "from", "had", "has", "have", "he", "her", "his", "i", "in", "is",
    "it", "its", "of", "on", "or", "she", "that", "the", "their", "they",
    "this", "to", "was", "were", "what", "when", "where", "who", "why",
    "with",
}


def tokens(text: str) -> list[str]:
    return [
        token
        for token in re.findall(r"[a-z0-9]+", text.lower())
        if len(token) > 1 and token not in STOPWORDS
    ]


def evidence_coverage(expected: str, memories: list[dict[str, Any]]) -> tuple[float, bool]:
    expected_tokens = tokens(expected)
    if not expected_tokens:
        return 0.0, False
    memory_text = " ".join(str(memory.get("content", "")) for memory in memories).lower()
    if expected.strip() and expected.strip().lower() in memory_text:
        return 1.0, True
    memory_tokens = set(tokens(memory_text))
    hits = sum(1 for token in expected_tokens if token in memory_tokens)
    coverage = hits / len(expected_tokens)
    return coverage, coverage >= 0.6


def load_rows(path: Path, allow_incomplete: bool) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("complete") is False and not allow_incomplete:
        raise SystemExit(
            f"{path} is marked incomplete; pass --allow-incomplete to inspect partial evidence."
        )
    rows = data.get("per_qa")
    if not isinstance(rows, list):
        raise SystemExit(f"{path} does not contain a per_qa list")
    return data, rows


def summarize(path: Path, allow_incomplete: bool, examples: int) -> None:
    data, rows = load_rows(path, allow_incomplete)
    overall = data.get("aggregate", {}).get("overall", {})
    print(f"File: {path}")
    print(f"Complete: {data.get('complete', 'unknown')}")
    print(f"Total QAs: {overall.get('total', len(rows))}")
    print(f"Mean score: {overall.get('mean_score', 'unknown')}")
    print()

    by_category: dict[str, list[dict[str, Any]]] = defaultdict(list)
    verdicts = Counter()
    miss_buckets = Counter()
    examples_by_bucket: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for row in rows:
        category = str(row.get("category_name", "unknown"))
        by_category[category].append(row)
        verdicts[str(row.get("judge_verdict", "unknown"))] += 1
        if row.get("score", 0) > 0 or row.get("is_adversarial"):
            continue
        coverage, found = evidence_coverage(
            str(row.get("expected_answer", "")),
            row.get("top_k_memories", []),
        )
        bucket = "retrieved-but-not-judged" if found else "not-retrieved"
        miss_buckets[bucket] += 1
        if len(examples_by_bucket[bucket]) < examples:
            row = dict(row)
            row["_coverage"] = coverage
            examples_by_bucket[bucket].append(row)

    print("By Category")
    for category, cat_rows in sorted(by_category.items()):
        mean = sum(float(row.get("score", 0)) for row in cat_rows) / len(cat_rows)
        print(f"- {category}: n={len(cat_rows)} mean={mean:.3f}")
    print()

    print("Verdicts")
    for verdict, count in verdicts.most_common():
        print(f"- {verdict}: {count}")
    print()

    print("Zero-Score Miss Buckets")
    for bucket, count in miss_buckets.most_common():
        print(f"- {bucket}: {count}")
    print()

    for bucket, bucket_examples in examples_by_bucket.items():
        print(f"Examples: {bucket}")
        for row in bucket_examples:
            memory = ""
            if row.get("top_k_memories"):
                memory = str(row["top_k_memories"][0].get("content", ""))[:240]
            print(f"- {row.get('conversation_id')} | {row.get('category_name')} | coverage={row['_coverage']:.2f}")
            print(f"  Q: {row.get('question')}")
            print(f"  Expected: {row.get('expected_answer')}")
            print(f"  Top memory: {memory}")
        print()


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze LoCoMo benchmark result JSONs.")
    parser.add_argument("result", type=Path)
    parser.add_argument("--allow-incomplete", action="store_true")
    parser.add_argument("--examples", type=int, default=5)
    args = parser.parse_args()
    summarize(args.result, allow_incomplete=args.allow_incomplete, examples=args.examples)


if __name__ == "__main__":
    main()
