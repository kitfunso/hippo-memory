"""Evaluate generated answers against LongMemEval ground truth.

Uses exact match and an LLM judge (Claude) to score answer correctness.
Reports per-question-type accuracy and overall accuracy.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from anthropic import Anthropic, APIError, RateLimitError
from tqdm import tqdm

logger = logging.getLogger(__name__)

JUDGE_MODEL = "claude-haiku-4-5-20251001"
MAX_RETRIES = 3
RETRY_BASE_DELAY = 2.0

JUDGE_SYSTEM_PROMPT = """\
You are an expert evaluator. Your job is to determine whether a generated answer \
is correct by comparing it to the ground truth answer.

Rules:
- The generated answer does NOT need to match the ground truth word-for-word.
- It IS correct if it conveys the same essential information or meaning.
- It IS correct if it provides a superset of the ground truth (extra details are fine).
- It is INCORRECT if it contradicts the ground truth or misses key facts.
- It is INCORRECT if it says "I don't know" when the ground truth has a real answer.
- For abstention questions (ground truth says info is not available), \
the answer is correct if it also abstains or says it doesn't know.

Respond with exactly one of these on the first line:
CORRECT
INCORRECT

Then optionally provide a brief explanation."""


@dataclass(frozen=True)
class JudgmentResult:
    """Result of a single answer evaluation."""

    question_id: str
    question_type: str
    is_correct: bool
    method: str  # "exact_match" or "llm_judge"
    explanation: str = ""


@dataclass
class EvalResults:
    """Aggregated evaluation results."""

    judgments: list[JudgmentResult] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.judgments)

    @property
    def correct(self) -> int:
        return sum(1 for j in self.judgments if j.is_correct)

    @property
    def accuracy(self) -> float:
        return self.correct / self.total if self.total > 0 else 0.0

    def per_type_accuracy(self) -> dict[str, dict[str, Any]]:
        """Compute accuracy grouped by question_type."""
        by_type: dict[str, list[JudgmentResult]] = defaultdict(list)
        for j in self.judgments:
            by_type[j.question_type].append(j)

        result: dict[str, dict[str, Any]] = {}
        for qtype, judgments in sorted(by_type.items()):
            n_correct = sum(1 for j in judgments if j.is_correct)
            result[qtype] = {
                "total": len(judgments),
                "correct": n_correct,
                "accuracy": n_correct / len(judgments) if judgments else 0.0,
            }
        return result

    def to_dict(self) -> dict[str, Any]:
        return {
            "overall": {
                "total": self.total,
                "correct": self.correct,
                "accuracy": self.accuracy,
            },
            "per_type": self.per_type_accuracy(),
            "judgments": [
                {
                    "question_id": j.question_id,
                    "question_type": j.question_type,
                    "is_correct": j.is_correct,
                    "method": j.method,
                    "explanation": j.explanation,
                }
                for j in self.judgments
            ],
        }


def normalize_answer(text: str) -> str:
    """Normalize an answer for exact match comparison."""
    text = text.lower().strip()
    # Remove punctuation
    text = re.sub(r"[^\w\s]", "", text)
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text)
    return text


def exact_match(generated: str, ground_truth: str) -> bool:
    """Check if generated answer matches ground truth after normalization."""
    return normalize_answer(generated) == normalize_answer(ground_truth)


def llm_judge(
    client: Anthropic,
    question: str,
    generated: str,
    ground_truth: str,
    model: str = JUDGE_MODEL,
) -> tuple[bool, str]:
    """Use Claude as a judge to evaluate answer correctness.

    Args:
        client: Anthropic API client.
        question: The original question.
        generated: The generated answer.
        ground_truth: The ground truth answer.
        model: Model to use for judging.

    Returns:
        Tuple of (is_correct, explanation).
    """
    user_message = (
        f"Question: {question}\n\n"
        f"Ground truth answer: {ground_truth}\n\n"
        f"Generated answer: {generated}\n\n"
        "Is the generated answer correct?"
    )

    for attempt in range(MAX_RETRIES):
        try:
            response = client.messages.create(
                model=model,
                max_tokens=256,
                system=JUDGE_SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_message}],
            )
            text = response.content[0].text.strip()
            first_line = text.split("\n")[0].strip().upper()
            is_correct = first_line == "CORRECT"
            explanation = "\n".join(text.split("\n")[1:]).strip()
            return is_correct, explanation
        except RateLimitError:
            delay = RETRY_BASE_DELAY * (2**attempt)
            logger.warning("Rate limited, retrying in %.1fs", delay)
            time.sleep(delay)
        except APIError as e:
            logger.error("API error during judging: %s", e)
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BASE_DELAY)
            else:
                return False, f"API error: {e}"

    return False, "Failed after retries"


def evaluate_all(
    generation_path: Path,
    output_path: Path | None = None,
    judge_model: str = JUDGE_MODEL,
    skip_llm_judge: bool = False,
) -> EvalResults:
    """Evaluate all generated answers.

    Args:
        generation_path: Path to generation JSONL file.
        output_path: Optional path to save evaluation results JSON.
        judge_model: Model for LLM judge.
        skip_llm_judge: If True, only use exact match (no API calls).

    Returns:
        EvalResults with all judgments.
    """
    if not generation_path.exists():
        raise FileNotFoundError(f"Generation results not found: {generation_path}")

    with open(generation_path, "r", encoding="utf-8") as f:
        entries = [json.loads(line) for line in f if line.strip()]

    logger.info("Evaluating %d answers", len(entries))

    client: Anthropic | None = None
    if not skip_llm_judge:
        client = Anthropic()

    results = EvalResults()

    for entry in tqdm(entries, desc="Evaluating", unit="answer"):
        question_id = entry["question_id"]
        question = entry["question"]
        ground_truth = entry["ground_truth"]
        generated = entry["generated_answer"]
        question_type = entry.get("question_type", "unknown")

        # Try exact match first
        if exact_match(generated, ground_truth):
            results.judgments.append(
                JudgmentResult(
                    question_id=question_id,
                    question_type=question_type,
                    is_correct=True,
                    method="exact_match",
                )
            )
            continue

        # Fall back to LLM judge
        if client is not None:
            is_correct, explanation = llm_judge(
                client=client,
                question=question,
                generated=generated,
                ground_truth=ground_truth,
                model=judge_model,
            )
            results.judgments.append(
                JudgmentResult(
                    question_id=question_id,
                    question_type=question_type,
                    is_correct=is_correct,
                    method="llm_judge",
                    explanation=explanation,
                )
            )
        else:
            # Exact match failed and no LLM judge
            results.judgments.append(
                JudgmentResult(
                    question_id=question_id,
                    question_type=question_type,
                    is_correct=False,
                    method="exact_match",
                    explanation="No exact match; LLM judge skipped.",
                )
            )

    # Print results
    _print_results(results)

    # Save results
    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(results.to_dict(), f, indent=2)
        logger.info("Saved evaluation results to %s", output_path)

    return results


def _print_results(results: EvalResults) -> None:
    """Print evaluation results to logger."""
    logger.info("=" * 60)
    logger.info("EVALUATION RESULTS")
    logger.info("=" * 60)
    logger.info(
        "Overall: %d/%d correct (%.1f%%)",
        results.correct,
        results.total,
        results.accuracy * 100,
    )
    logger.info("-" * 60)

    for qtype, stats in results.per_type_accuracy().items():
        logger.info(
            "  %-30s %d/%d (%.1f%%)",
            qtype,
            stats["correct"],
            stats["total"],
            stats["accuracy"] * 100,
        )

    logger.info("=" * 60)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate LongMemEval generated answers against ground truth."
    )
    parser.add_argument(
        "--generation",
        type=Path,
        required=True,
        help="Path to generation JSONL file.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("results/evaluation.json"),
        help="Path to save evaluation results JSON (default: results/evaluation.json).",
    )
    parser.add_argument(
        "--judge-model",
        type=str,
        default=JUDGE_MODEL,
        help=f"Model for LLM judge (default: {JUDGE_MODEL}).",
    )
    parser.add_argument(
        "--skip-llm-judge",
        action="store_true",
        help="Skip LLM judge, only use exact match.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging.",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    try:
        evaluate_all(
            args.generation, args.output, args.judge_model, args.skip_llm_judge
        )
    except Exception:
        logger.exception("Evaluation failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
