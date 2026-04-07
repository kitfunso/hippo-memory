"""Evaluate hippo retrieval accuracy against LongMemEval ground truth.

No API key required. Uses answer_session_ids from the dataset to check
whether hippo retrieved memories from the correct sessions.

Metrics: Recall@K (did the correct session appear in top-K results?)
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def load_retrieval_results(path: Path) -> list[dict[str, Any]]:
    """Load retrieval JSONL results."""
    results = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                results.append(json.loads(line))
    return results


def load_dataset(path: Path) -> dict[str, dict[str, Any]]:
    """Load dataset indexed by question_id."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        for key in ("data", "questions", "entries"):
            if key in data:
                data = data[key]
                break
    return {e["question_id"]: e for e in data}


def check_session_hit(
    retrieved_memories: list[dict[str, Any]],
    answer_session_ids: list[str],
    top_k: int,
) -> bool:
    """Check if any of the top-K retrieved memories came from an answer session."""
    for mem in retrieved_memories[:top_k]:
        tags = mem.get("tags", [])
        content = mem.get("content", "")
        for sid in answer_session_ids:
            # Check tags for session ID
            if sid in tags:
                return True
            # Check content for session marker
            if f"[Session: {sid}]" in content:
                return True
            # Partial match on session ID in tags
            if any(sid in t for t in tags):
                return True
    return False


def check_answer_in_content(
    retrieved_memories: list[dict[str, Any]],
    answer: str,
    top_k: int,
) -> bool:
    """Check if the ground truth answer text appears in retrieved content."""
    answer_lower = str(answer).lower().strip()
    if not answer_lower or len(answer_lower) < 3:
        return False

    # Split answer into key terms (words > 3 chars)
    answer_terms = [w for w in answer_lower.split() if len(w) > 3]
    if not answer_terms:
        return False

    for mem in retrieved_memories[:top_k]:
        content = mem.get("content", "").lower()
        # Check if answer appears verbatim
        if answer_lower in content:
            return True
        # Check if most answer terms appear
        matched = sum(1 for t in answer_terms if t in content)
        if len(answer_terms) > 0 and matched / len(answer_terms) >= 0.6:
            return True

    return False


def evaluate_retrieval(
    retrieval_path: Path,
    dataset_path: Path,
    output_path: Path | None = None,
    k_values: list[int] | None = None,
) -> dict[str, Any]:
    """Evaluate retrieval accuracy.

    Args:
        retrieval_path: Path to retrieval JSONL.
        dataset_path: Path to original LongMemEval JSON.
        output_path: Optional path to save results.
        k_values: List of K values for Recall@K (default: [1, 3, 5, 10]).

    Returns:
        Dict with evaluation results.
    """
    if k_values is None:
        k_values = [1, 3, 5, 10]

    retrieval_results = load_retrieval_results(retrieval_path)
    dataset = load_dataset(dataset_path)

    logger.info("Evaluating %d retrieval results", len(retrieval_results))

    # Per-type tracking
    by_type: dict[str, dict[str, list[bool]]] = defaultdict(
        lambda: {f"recall@{k}": [] for k in k_values} | {"answer_in_content@5": []}
    )
    overall: dict[str, list[bool]] = {
        f"recall@{k}": [] for k in k_values
    } | {"answer_in_content@5": []}

    empty_retrievals = 0

    for result in retrieval_results:
        qid = result["question_id"]
        qtype = result.get("question_type", "unknown")
        memories = result.get("retrieved_memories", [])
        answer = result.get("answer", "")

        if not memories:
            empty_retrievals += 1

        # Get ground truth session IDs
        entry = dataset.get(qid, {})
        answer_session_ids = entry.get("answer_session_ids", [])

        # Session-based recall
        for k in k_values:
            hit = check_session_hit(memories, answer_session_ids, k) if answer_session_ids else False
            by_type[qtype][f"recall@{k}"].append(hit)
            overall[f"recall@{k}"].append(hit)

        # Answer-in-content check
        content_hit = check_answer_in_content(memories, answer, 5)
        by_type[qtype]["answer_in_content@5"].append(content_hit)
        overall["answer_in_content@5"].append(content_hit)

    # Compute averages
    def avg(lst: list[bool]) -> float:
        return sum(lst) / len(lst) if lst else 0.0

    results: dict[str, Any] = {
        "benchmark": "longmemeval-retrieval",
        "total_questions": len(retrieval_results),
        "empty_retrievals": empty_retrievals,
        "overall": {metric: round(avg(hits) * 100, 1) for metric, hits in overall.items()},
        "per_type": {},
    }

    for qtype in sorted(by_type.keys()):
        results["per_type"][qtype] = {
            "count": len(by_type[qtype][f"recall@{k_values[0]}"]),
            **{metric: round(avg(hits) * 100, 1) for metric, hits in by_type[qtype].items()},
        }

    # Print results
    print()
    print("=" * 70)
    print("  LONGMEMEVAL RETRIEVAL EVALUATION (no API key required)")
    print("=" * 70)
    print(f"  Total questions: {results['total_questions']}")
    print(f"  Empty retrievals: {results['empty_retrievals']}")
    print()
    print("  Overall:")
    for metric, value in results["overall"].items():
        print(f"    {metric:25s} {value:6.1f}%")
    print()
    print("  Per question type:")
    print(f"    {'Type':<30s} {'Count':>5s} {'R@1':>6s} {'R@5':>6s} {'Ans@5':>6s}")
    print("    " + "-" * 55)
    for qtype, stats in results["per_type"].items():
        r1 = stats.get("recall@1", 0)
        r5 = stats.get("recall@5", 0)
        a5 = stats.get("answer_in_content@5", 0)
        print(f"    {qtype:<30s} {stats['count']:>5d} {r1:>5.1f}% {r5:>5.1f}% {a5:>5.1f}%")
    print("=" * 70)

    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)
        print(f"\n  Results saved to: {output_path}")

    return results


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate hippo retrieval accuracy on LongMemEval (no API key needed)."
    )
    parser.add_argument(
        "--retrieval", type=Path, required=True,
        help="Path to retrieval JSONL file.",
    )
    parser.add_argument(
        "--data", type=Path, required=True,
        help="Path to original LongMemEval JSON dataset.",
    )
    parser.add_argument(
        "--output", type=Path, default=None,
        help="Path to save evaluation results JSON.",
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help="Enable verbose logging.",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    evaluate_retrieval(args.retrieval, args.data, args.output)


if __name__ == "__main__":
    main()
