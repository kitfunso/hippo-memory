"""Full LongMemEval benchmark pipeline orchestrator.

Runs: ingest -> retrieve -> generate -> evaluate
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
import time
from pathlib import Path

from evaluate import evaluate_all
from generate import generate_all
from ingest import ingest_sessions
from retrieve import retrieve_all

logger = logging.getLogger(__name__)


def verify_hippo_binary(hippo_bin: str) -> None:
    """Verify the hippo binary is accessible."""
    resolved = shutil.which(hippo_bin)
    if resolved is None:
        raise FileNotFoundError(
            f"hippo binary not found: '{hippo_bin}'. "
            "Install with: npm install -g hippo-memory"
        )
    logger.info("Using hippo binary: %s", resolved)


def run_pipeline(
    data_path: Path,
    output_dir: Path,
    hippo_bin: str = "hippo",
    model: str = "claude-haiku-4-5-20251001",
    judge_model: str = "claude-haiku-4-5-20251001",
    budget: int = 4000,
    skip_ingest: bool = False,
    skip_generate: bool = False,
    skip_evaluate: bool = False,
    store_dir: Path | None = None,
) -> dict:
    """Run the full LongMemEval benchmark pipeline.

    Args:
        data_path: Path to LongMemEval JSON dataset.
        output_dir: Directory for all output files.
        hippo_bin: Path to hippo CLI binary.
        model: Claude model for answer generation.
        judge_model: Claude model for LLM judge.
        budget: Token budget for retrieval.
        skip_ingest: Skip ingestion (reuse existing store_dir).
        skip_generate: Skip generation (reuse existing generation results).
        skip_evaluate: Skip evaluation.
        store_dir: Reuse existing hippo store directory.

    Returns:
        Dict with pipeline results and timing.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    retrieval_path = output_dir / "retrieval.jsonl"
    generation_path = output_dir / "generation.jsonl"
    evaluation_path = output_dir / "evaluation.json"

    timings: dict[str, float] = {}
    pipeline_start = time.time()

    # Step 1: Ingest
    if not skip_ingest:
        logger.info("=" * 60)
        logger.info("STEP 1/4: INGEST")
        logger.info("=" * 60)
        t0 = time.time()
        store_dir = ingest_sessions(
            data_path=data_path,
            hippo_bin=hippo_bin,
            store_dir=store_dir,
        )
        timings["ingest"] = time.time() - t0
        logger.info("Ingestion completed in %.1fs", timings["ingest"])
    else:
        if store_dir is None:
            raise ValueError("--store-dir required when using --skip-ingest")
        logger.info("Skipping ingestion, using store: %s", store_dir)

    # Step 2: Retrieve
    logger.info("=" * 60)
    logger.info("STEP 2/4: RETRIEVE")
    logger.info("=" * 60)
    t0 = time.time()
    retrieve_all(
        data_path=data_path,
        store_dir=store_dir,
        output_path=retrieval_path,
        hippo_bin=hippo_bin,
        budget=budget,
    )
    timings["retrieve"] = time.time() - t0
    logger.info("Retrieval completed in %.1fs", timings["retrieve"])

    # Step 3: Generate
    if not skip_generate:
        logger.info("=" * 60)
        logger.info("STEP 3/4: GENERATE")
        logger.info("=" * 60)
        t0 = time.time()
        generate_all(
            retrieval_path=retrieval_path,
            output_path=generation_path,
            model=model,
        )
        timings["generate"] = time.time() - t0
        logger.info("Generation completed in %.1fs", timings["generate"])
    else:
        logger.info("Skipping generation, using existing: %s", generation_path)

    # Step 4: Evaluate
    if not skip_evaluate:
        logger.info("=" * 60)
        logger.info("STEP 4/4: EVALUATE")
        logger.info("=" * 60)
        t0 = time.time()
        results = evaluate_all(
            generation_path=generation_path,
            output_path=evaluation_path,
            judge_model=judge_model,
        )
        timings["evaluate"] = time.time() - t0
        logger.info("Evaluation completed in %.1fs", timings["evaluate"])
    else:
        logger.info("Skipping evaluation")
        results = None

    timings["total"] = time.time() - pipeline_start

    # Save pipeline metadata
    metadata = {
        "data_path": str(data_path),
        "output_dir": str(output_dir),
        "store_dir": str(store_dir),
        "model": model,
        "judge_model": judge_model,
        "budget": budget,
        "timings": timings,
    }
    if results is not None:
        metadata["results"] = results.to_dict()

    meta_path = output_dir / "pipeline_metadata.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    logger.info("=" * 60)
    logger.info("PIPELINE COMPLETE")
    logger.info("Total time: %.1fs", timings["total"])
    if results is not None:
        logger.info(
            "Overall accuracy: %d/%d (%.1f%%)",
            results.correct,
            results.total,
            results.accuracy * 100,
        )
    logger.info("Results saved to: %s", output_dir)
    logger.info("=" * 60)

    return metadata


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run full LongMemEval benchmark pipeline: ingest -> retrieve -> generate -> evaluate."
    )
    parser.add_argument(
        "--data",
        type=Path,
        required=True,
        help="Path to LongMemEval JSON dataset.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("results"),
        help="Directory for output files (default: ./results).",
    )
    parser.add_argument(
        "--hippo",
        type=str,
        default="hippo",
        help="Path to hippo CLI binary (default: hippo).",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="claude-haiku-4-5-20251001",
        help="Claude model for answer generation (default: claude-haiku-4-5-20251001).",
    )
    parser.add_argument(
        "--judge-model",
        type=str,
        default="claude-haiku-4-5-20251001",
        help="Claude model for LLM judge (default: claude-haiku-4-5-20251001).",
    )
    parser.add_argument(
        "--budget",
        type=int,
        default=4000,
        help="Token budget for retrieval (default: 4000).",
    )
    parser.add_argument(
        "--store-dir",
        type=Path,
        default=None,
        help="Directory for hippo store (default: temp directory).",
    )
    parser.add_argument(
        "--skip-ingest",
        action="store_true",
        help="Skip ingestion (reuse existing store_dir).",
    )
    parser.add_argument(
        "--skip-generate",
        action="store_true",
        help="Skip generation (reuse existing generation results).",
    )
    parser.add_argument(
        "--skip-evaluate",
        action="store_true",
        help="Skip evaluation.",
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
        verify_hippo_binary(args.hippo)
        run_pipeline(
            data_path=args.data,
            output_dir=args.output_dir,
            hippo_bin=args.hippo,
            model=args.model,
            judge_model=args.judge_model,
            budget=args.budget,
            skip_ingest=args.skip_ingest,
            skip_generate=args.skip_generate,
            skip_evaluate=args.skip_evaluate,
            store_dir=args.store_dir,
        )
    except Exception:
        logger.exception("Pipeline failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
