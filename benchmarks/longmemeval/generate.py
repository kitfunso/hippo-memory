"""Generate answers for LongMemEval questions using retrieved context.

Reads retrieval results (JSONL), constructs prompts with retrieved memories
as context, and calls Claude API to generate answers.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any

from anthropic import Anthropic, APIError, RateLimitError
from tqdm import tqdm

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-haiku-4-5-20251001"
MAX_RETRIES = 3
RETRY_BASE_DELAY = 2.0

SYSTEM_PROMPT = """\
You are answering questions based on retrieved conversation memories.
Answer the question using ONLY the information provided in the retrieved memories below.
If the memories do not contain enough information to answer, say "I don't know" or \
"I don't have enough information to answer this question."
Be concise and direct. Do not explain your reasoning unless the question asks for it."""


def format_context(memories: list[dict[str, Any]]) -> str:
    """Format retrieved memories into a context string for the prompt."""
    if not memories:
        return "[No relevant memories found]"

    parts: list[str] = []
    for i, mem in enumerate(memories, 1):
        content = mem.get("content", "")
        tags = mem.get("tags", [])
        score = mem.get("score", 0)

        header = f"--- Memory {i} (score: {score:.3f})"
        if tags:
            header += f", tags: {', '.join(tags)}"
        header += " ---"

        parts.append(f"{header}\n{content}")

    return "\n\n".join(parts)


def generate_answer(
    client: Anthropic,
    question: str,
    memories: list[dict[str, Any]],
    model: str,
    question_date: str = "",
) -> str:
    """Generate an answer using Claude API with retrieved context.

    Args:
        client: Anthropic API client.
        question: The question to answer.
        memories: Retrieved memory entries.
        model: Model identifier.
        question_date: Date context for temporal reasoning.

    Returns:
        Generated answer string.
    """
    context = format_context(memories)

    user_message = f"Retrieved memories:\n{context}\n\n"
    if question_date:
        user_message += f"Current date: {question_date}\n\n"
    user_message += f"Question: {question}"

    for attempt in range(MAX_RETRIES):
        try:
            response = client.messages.create(
                model=model,
                max_tokens=512,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_message}],
            )
            return response.content[0].text
        except RateLimitError:
            delay = RETRY_BASE_DELAY * (2**attempt)
            logger.warning("Rate limited, retrying in %.1fs (attempt %d)", delay, attempt + 1)
            time.sleep(delay)
        except APIError as e:
            logger.error("API error: %s", e)
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BASE_DELAY)
            else:
                raise

    return "[Generation failed after retries]"


def generate_all(
    retrieval_path: Path,
    output_path: Path,
    model: str = DEFAULT_MODEL,
) -> Path:
    """Generate answers for all retrieved questions.

    Args:
        retrieval_path: Path to retrieval JSONL file.
        output_path: Path to write generation JSONL results.
        model: Claude model to use for generation.

    Returns:
        Path to the output JSONL file.
    """
    if not retrieval_path.exists():
        raise FileNotFoundError(f"Retrieval results not found: {retrieval_path}")

    client = Anthropic()

    # Count lines for progress bar
    with open(retrieval_path, "r", encoding="utf-8") as f:
        entries = [json.loads(line) for line in f if line.strip()]

    logger.info("Generating answers for %d questions using %s", len(entries), model)

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        for entry in tqdm(entries, desc="Generating", unit="question"):
            question_id = entry["question_id"]
            question = entry["question"]
            ground_truth = entry["answer"]
            question_type = entry.get("question_type", "")
            question_date = entry.get("question_date", "")
            memories = entry.get("retrieved_memories", [])

            generated = generate_answer(
                client=client,
                question=question,
                memories=memories,
                model=model,
                question_date=question_date,
            )

            result = {
                "question_id": question_id,
                "question": question,
                "ground_truth": ground_truth,
                "generated_answer": generated,
                "question_type": question_type,
                "num_memories_used": len(memories),
            }
            f.write(json.dumps(result, ensure_ascii=False) + "\n")

    logger.info("Saved generated answers to %s", output_path)
    return output_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate answers for LongMemEval using retrieved context and Claude API."
    )
    parser.add_argument(
        "--retrieval",
        type=Path,
        required=True,
        help="Path to retrieval JSONL file.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("results/generation.jsonl"),
        help="Path to write generation JSONL (default: results/generation.jsonl).",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=DEFAULT_MODEL,
        help=f"Claude model for generation (default: {DEFAULT_MODEL}).",
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
        generate_all(args.retrieval, args.output, args.model)
    except Exception:
        logger.exception("Generation failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
