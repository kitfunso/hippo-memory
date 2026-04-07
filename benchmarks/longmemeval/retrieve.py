"""Retrieve memories for each LongMemEval question using hippo recall.

For each question, calls `hippo recall "<question>" --json --budget N`
and saves the retrieval results in JSONL format.
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
from pathlib import Path
from typing import Any

from tqdm import tqdm

logger = logging.getLogger(__name__)


def load_dataset(data_path: Path) -> list[dict[str, Any]]:
    """Load LongMemEval dataset from a JSON file."""
    if not data_path.exists():
        raise FileNotFoundError(f"Dataset not found: {data_path}")

    with open(data_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if isinstance(data, dict):
        for key in ("data", "questions", "entries"):
            if key in data:
                data = data[key]
                break

    if not isinstance(data, list):
        raise ValueError(f"Expected a list of entries, got {type(data).__name__}")

    return data


def recall_memories(
    query: str,
    hippo_bin: str,
    store_dir: str,
    budget: int = 4000,
    timeout: int = 30,
) -> list[dict[str, Any]]:
    """Call hippo recall and return retrieved memories.

    Args:
        query: The question to use as recall query.
        hippo_bin: Path to hippo CLI binary.
        store_dir: Directory containing the .hippo/ store.
        budget: Token budget for retrieval.
        timeout: Command timeout in seconds.

    Returns:
        List of memory result dicts from hippo recall --json output.
    """
    cmd = [hippo_bin, "recall", query, "--json", "--budget", str(budget)]

    # Isolate from global ~/.hippo store by overriding HOME/USERPROFILE
    import os
    env = {**os.environ, "HOME": str(store_dir), "USERPROFILE": str(store_dir)}

    try:
        result = subprocess.run(
            cmd,
            cwd=store_dir,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            shell=(sys.platform == "win32"),
        )
    except FileNotFoundError:
        logger.error("hippo binary not found: %s", hippo_bin)
        raise
    except subprocess.TimeoutExpired:
        logger.warning("Recall timed out for query: %.80s...", query)
        return []

    if result.returncode != 0:
        logger.warning(
            "Recall failed (rc=%d) for query: %.80s...\nstderr: %s",
            result.returncode,
            query,
            result.stderr.strip(),
        )
        return []

    stdout = result.stdout.strip()
    if not stdout:
        return []

    try:
        data = json.loads(stdout)
        return data.get("results", [])
    except json.JSONDecodeError:
        logger.warning("Failed to parse recall JSON: %.200s", stdout)
        return []


def retrieve_all(
    data_path: Path,
    store_dir: Path,
    output_path: Path,
    hippo_bin: str = "hippo",
    budget: int = 4000,
) -> Path:
    """Retrieve memories for all questions and save to JSONL.

    Args:
        data_path: Path to LongMemEval JSON dataset.
        store_dir: Directory containing the .hippo/ store.
        output_path: Path to write JSONL results.
        hippo_bin: Path to hippo CLI binary.
        budget: Token budget for retrieval.

    Returns:
        Path to the output JSONL file.
    """
    entries = load_dataset(data_path)
    logger.info("Retrieving memories for %d questions", len(entries))

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        for entry in tqdm(entries, desc="Retrieving", unit="question"):
            question_id = entry.get("question_id", "unknown")
            question = entry.get("question", "")
            answer = entry.get("answer", "")
            question_type = entry.get("question_type", "")
            question_date = entry.get("question_date", "")

            memories = recall_memories(
                query=question,
                hippo_bin=hippo_bin,
                store_dir=str(store_dir),
                budget=budget,
            )

            result = {
                "question_id": question_id,
                "question": question,
                "answer": answer,
                "question_type": question_type,
                "question_date": question_date,
                "retrieved_memories": memories,
                "num_retrieved": len(memories),
            }
            f.write(json.dumps(result, ensure_ascii=False) + "\n")

    logger.info("Saved retrieval results to %s", output_path)
    return output_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Retrieve memories for LongMemEval questions using hippo recall."
    )
    parser.add_argument(
        "--data",
        type=Path,
        required=True,
        help="Path to LongMemEval JSON dataset.",
    )
    parser.add_argument(
        "--store-dir",
        type=Path,
        required=True,
        help="Directory containing the .hippo/ store.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("results/retrieval.jsonl"),
        help="Path to write JSONL results (default: results/retrieval.jsonl).",
    )
    parser.add_argument(
        "--hippo",
        type=str,
        default="hippo",
        help="Path to hippo CLI binary (default: hippo).",
    )
    parser.add_argument(
        "--budget",
        type=int,
        default=4000,
        help="Token budget for retrieval (default: 4000).",
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
        retrieve_all(args.data, args.store_dir, args.output, args.hippo, args.budget)
    except Exception:
        logger.exception("Retrieval failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
