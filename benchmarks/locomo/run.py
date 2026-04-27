"""Run the LoCoMo benchmark against hippo-memory.

For each LoCoMo conversation:
  1. Create a fresh HIPPO_HOME.
  2. hippo init.
  3. Ingest every session turn as a memory via `hippo remember`.
  4. For every QA in that conversation, run `hippo recall --json`.
  5. LLM-judge (via `claude -p` CLI) whether the top-K memories answer the question.

Outputs a single JSON at results/hippo-v{version}.json with per-QA judgments +
overall + per-category accuracy.

Honors the brief's non-negotiables:
  - Uses globally installed `hippo` CLI.
  - Fresh HIPPO_HOME per conversation (no cross-conversation leakage).
  - No hippo source changes.
  - Judge model id recorded in the output.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable

from tqdm import tqdm

logger = logging.getLogger(__name__)

# --- Configuration ---

JUDGE_MODEL = "claude-opus-4-7"  # label for the `claude -p` CLI used; actual model governed by the CLI install

JUDGE_PROMPT_TEMPLATE = """\
You are grading a memory-retrieval system.

Question: {question}
Expected answer: {expected}
Retrieved memories (top-{k}):
{memories}

Is the expected answer derivable from the retrieved memories? \
Answer with EXACTLY one word on the first line: equivalent, partial, or wrong.

- equivalent: a memory clearly contains the answer.
- partial: a memory is on topic but missing the specific fact.
- wrong: no retrieved memory supports the answer.
"""

# Adversarial = unanswerable. We score correct if hippo returns nothing substantive.
JUDGE_PROMPT_ADVERSARIAL = """\
You are grading a memory-retrieval system on an UNANSWERABLE question.

Question: {question}
(This question has no answer in the source conversation.)
Retrieved memories (top-{k}):
{memories}

Do any retrieved memories actually answer this question? \
Answer with EXACTLY one word on the first line: none, weak, or strong.

- none: no memory addresses the question -> correct abstention.
- weak: a memory is tangentially related but does not answer.
- strong: a memory falsely answers the question.
"""

CATEGORY_NAMES = {
    1: "single-hop",
    2: "multi-hop",
    3: "temporal-reasoning",
    4: "open-domain",
    5: "adversarial",
}

# --- Data types ---

@dataclass(frozen=True)
class QAResult:
    conversation_id: str
    qa_index: int
    question: str
    expected_answer: str
    category: int
    category_name: str
    is_adversarial: bool
    top_k_memories: list[dict[str, Any]]
    judge_verdict: str  # "equivalent" / "partial" / "wrong" OR "none"/"weak"/"strong" for adversarial
    score: float  # 0.0 / 0.5 / 1.0

# --- Helpers ---

def load_dataset(data_path: Path) -> list[dict[str, Any]]:
    if not data_path.exists():
        raise FileNotFoundError(f"Dataset not found: {data_path}")
    with open(data_path, "r", encoding="utf-8") as f:
        return json.load(f)


def collect_turns(conv: dict[str, Any]) -> list[tuple[int, str, str, str]]:
    """Yield (session_n, dia_id, speaker, text) for every turn in every session."""
    turns: list[tuple[int, str, str, str]] = []
    session_keys = sorted(
        [k for k in conv if re.fullmatch(r"session_\d+", k) and isinstance(conv[k], list)],
        key=lambda s: int(s.split("_")[1]),
    )
    for sk in session_keys:
        n = int(sk.split("_")[1])
        date = conv.get(f"{sk}_date_time", "")
        for turn in conv[sk]:
            dia_id = turn.get("dia_id", "")
            speaker = turn.get("speaker", "unknown")
            text = turn.get("text", "")
            if text:
                # Prefix with date for temporal grounding — this mirrors what
                # any sane hippo user would do when ingesting a dated utterance.
                prefixed = f"[{date}] {speaker}: {text}" if date else f"{speaker}: {text}"
                turns.append((n, dia_id, speaker, prefixed))
    return turns


def run_hippo(
    args: list[str],
    cwd: str,
    hippo_home: str,
    stdin_text: str | None = None,
    timeout: int = 30,
) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "HIPPO_HOME": hippo_home}
    # Force isolation from global ~/.hippo as a belt-and-braces measure.
    env["HOME"] = hippo_home
    env["USERPROFILE"] = hippo_home
    cmd = ["hippo"] + args
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        shell=(sys.platform == "win32"),
        input=stdin_text,
        timeout=timeout,
    )


def hippo_init(hippo_home: str, salience: bool = False) -> None:
    result = run_hippo(
        ["init", "--no-hooks", "--no-schedule", "--no-learn"],
        cwd=hippo_home,
        hippo_home=hippo_home,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"hippo init failed: {result.stderr}")
    # Salience gate is OFF by default. The 2026-04-24 LoCoMo run with
    # salience=true collapsed mean_score from 0.279 (v0.32) to 0.020
    # because the write-time lexical-overlap gate dropped same-conversation
    # turns as duplicates. Pass --salience to opt in for ablation runs.
    if salience:
        hippo_dir = os.path.join(hippo_home, ".hippo")
        os.makedirs(hippo_dir, exist_ok=True)
        config_path = os.path.join(hippo_dir, "config.json")
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump({"salience": {"enabled": True}}, f, indent=2)


def hippo_remember(hippo_home: str, text: str, tags: list[str]) -> bool:
    args = ["remember", text]
    for t in tags:
        args.extend(["--tag", t])
    try:
        result = run_hippo(args, cwd=hippo_home, hippo_home=hippo_home, timeout=30)
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        logger.warning("remember timed out for: %.80s", text)
        return False


def hippo_recall(hippo_home: str, query: str, budget: int = 4000) -> list[dict[str, Any]]:
    try:
        result = run_hippo(
            ["recall", query, "--json", "--budget", str(budget)],
            cwd=hippo_home,
            hippo_home=hippo_home,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        logger.warning("recall timed out for: %.80s", query)
        return []
    if result.returncode != 0:
        logger.warning("recall rc=%d: %s", result.returncode, result.stderr[:200])
        return []
    stdout = result.stdout.strip()
    if not stdout:
        return []
    try:
        data = json.loads(stdout)
        return data.get("results", [])
    except json.JSONDecodeError:
        # stdout may include SQLite warning lines; strip to the JSON
        # Find first '{' and parse from there
        brace = stdout.find("{")
        if brace >= 0:
            try:
                return json.loads(stdout[brace:]).get("results", [])
            except json.JSONDecodeError:
                pass
        logger.warning("recall JSON parse failed: %.160s", stdout)
        return []


def format_memories_for_judge(memories: list[dict[str, Any]], top_k: int) -> str:
    if not memories:
        return "  (no memories returned)"
    lines = []
    for i, m in enumerate(memories[:top_k], 1):
        content = m.get("content", "").replace("\n", " ").strip()
        lines.append(f"  {i}. {content}")
    return "\n".join(lines)


def judge_with_claude_cli(prompt: str, timeout: int = 60) -> str:
    """Invoke `claude -p` as the judge. Returns the one-word verdict."""
    try:
        result = subprocess.run(
            ["claude", "-p", "--output-format", "text"],
            input=prompt,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            shell=(sys.platform == "win32"),
        )
    except subprocess.TimeoutExpired:
        logger.warning("judge timed out")
        return "wrong"
    if result.returncode != 0:
        logger.warning("judge rc=%d: %s", result.returncode, result.stderr[:200])
        return "wrong"
    text = result.stdout.strip().lower()
    # Grab first recognizable token
    for token in ("equivalent", "partial", "wrong", "none", "weak", "strong"):
        if token in text.split()[:5] if text else []:
            return token
    # Fall back to first word
    first = text.split()[0].strip(".,:;!?") if text else ""
    return first or "wrong"


def score_verdict(verdict: str, is_adversarial: bool) -> float:
    if is_adversarial:
        return {"none": 1.0, "weak": 0.5, "strong": 0.0}.get(verdict, 0.0)
    return {"equivalent": 1.0, "partial": 0.5, "wrong": 0.0}.get(verdict, 0.0)


# --- Main loop ---

def process_conversation(
    conv_entry: dict[str, Any],
    top_k: int,
    sample_n: int | None,
    skip_adversarial: bool,
    budget: int,
    flush_file=None,
    salience: bool = False,
) -> list[QAResult]:
    sample_id = conv_entry["sample_id"]
    conv = conv_entry["conversation"]
    qa_list = conv_entry["qa"]

    if skip_adversarial:
        qa_list = [qa for qa in qa_list if qa.get("category") != 5]
    if sample_n is not None and sample_n < len(qa_list):
        # Deterministic STRATIFIED sample: proportional allocation across categories.
        # Seed is fixed per conversation so the same sample is reproducible.
        import random
        rng = random.Random(0xC0C0 ^ (hash(sample_id) & 0xFFFFFFFF))
        by_cat: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for qa in qa_list:
            by_cat[qa.get("category", 0)].append(qa)
        sampled: list[dict[str, Any]] = []
        total = len(qa_list)
        for cat, qas in by_cat.items():
            # Round to at least 1 per category if it exists
            take = max(1, round(sample_n * len(qas) / total))
            rng.shuffle(qas)
            sampled.extend(qas[:take])
        # Trim or pad to exact sample_n deterministically
        rng.shuffle(sampled)
        qa_list = sampled[:sample_n]

    logger.info("[%s] %d QAs to score", sample_id, len(qa_list))

    # Fresh HIPPO_HOME per conversation
    hippo_home = tempfile.mkdtemp(prefix=f"hippo_locomo_{sample_id}_")
    try:
        hippo_init(hippo_home, salience=salience)

        # Ingest all turns
        turns = collect_turns(conv)
        logger.info("[%s] ingesting %d turns", sample_id, len(turns))
        ingested = 0
        for (session_n, dia_id, speaker, text) in tqdm(
            turns, desc=f"Ingest {sample_id}", unit="turn", leave=False
        ):
            tags = [
                f"conv:{sample_id}",
                f"session:{session_n}",
                f"speaker:{speaker}",
                f"dia:{dia_id}",
            ]
            if hippo_remember(hippo_home, text, tags):
                ingested += 1
        logger.info("[%s] ingested %d/%d turns", sample_id, ingested, len(turns))

        # Retrieve + judge
        results: list[QAResult] = []
        for i, qa in enumerate(
            tqdm(qa_list, desc=f"Score {sample_id}", unit="qa", leave=False)
        ):
            question = qa.get("question", "")
            category = qa.get("category", 0)
            is_adv = category == 5
            expected = (
                qa.get("adversarial_answer", "") if is_adv else str(qa.get("answer", ""))
            )

            memories = hippo_recall(hippo_home, question, budget=budget)
            mem_block = format_memories_for_judge(memories, top_k)

            template = JUDGE_PROMPT_ADVERSARIAL if is_adv else JUDGE_PROMPT_TEMPLATE
            prompt = template.format(
                question=question, expected=expected, memories=mem_block, k=top_k
            )
            verdict = judge_with_claude_cli(prompt)
            score = score_verdict(verdict, is_adv)

            qa_result = QAResult(
                conversation_id=sample_id,
                qa_index=i,
                question=question,
                expected_answer=expected,
                category=category,
                category_name=CATEGORY_NAMES.get(category, f"cat{category}"),
                is_adversarial=is_adv,
                top_k_memories=[
                    {"content": m.get("content", ""), "score": m.get("score", 0.0)}
                    for m in memories[:top_k]
                ],
                judge_verdict=verdict,
                score=score,
            )
            results.append(qa_result)
            if flush_file is not None:
                flush_file.write(json.dumps(asdict(qa_result), ensure_ascii=False) + "\n")
                flush_file.flush()
        return results
    finally:
        try:
            shutil.rmtree(hippo_home, ignore_errors=True)
        except Exception:
            pass


def aggregate(results: list[QAResult]) -> dict[str, Any]:
    total = len(results)
    if total == 0:
        return {"overall": {"total": 0, "score": 0.0}, "per_category": {}}

    overall_score = sum(r.score for r in results) / total

    by_cat: dict[int, list[QAResult]] = defaultdict(list)
    for r in results:
        by_cat[r.category].append(r)
    per_cat = {}
    for cat, rs in sorted(by_cat.items()):
        per_cat[CATEGORY_NAMES.get(cat, f"cat{cat}")] = {
            "total": len(rs),
            "mean_score": sum(r.score for r in rs) / len(rs),
            "n_equivalent": sum(1 for r in rs if r.score == 1.0),
            "n_partial": sum(1 for r in rs if r.score == 0.5),
            "n_wrong": sum(1 for r in rs if r.score == 0.0),
        }

    return {
        "overall": {
            "total": total,
            "mean_score": overall_score,
            "n_equivalent": sum(1 for r in results if r.score == 1.0),
            "n_partial": sum(1 for r in results if r.score == 0.5),
            "n_wrong": sum(1 for r in results if r.score == 0.0),
        },
        "per_category": per_cat,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run LoCoMo benchmark against hippo.")
    parser.add_argument("--data", type=Path, default=Path("data/locomo10.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("results"))
    parser.add_argument("--output-name", type=str, default=None)
    parser.add_argument("--conversations", type=int, default=None,
                        help="Limit to first K conversations (default: all).")
    parser.add_argument("--sample", type=int, default=None,
                        help="Sample N QAs per conversation (default: all).")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--budget", type=int, default=4000)
    parser.add_argument("--skip-adversarial", action="store_true")
    parser.add_argument("--resume", action="store_true",
                        help="Skip conversations already in incremental file.")
    parser.add_argument("--judge-model", type=str, default=JUDGE_MODEL)
    parser.add_argument("--salience", action="store_true",
                        help="Enable pineal salience gate (default off, see hippo_init docstring).")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    # Verify hippo version
    v_result = subprocess.run(
        ["hippo", "--version"], capture_output=True, text=True, shell=(sys.platform == "win32"),
    )
    hippo_version = v_result.stdout.strip() or "unknown"
    logger.info("hippo --version: %s", hippo_version)

    if args.output_name is None:
        args.output_name = f"hippo-v{hippo_version}.json"

    data = load_dataset(args.data)
    if args.conversations is not None:
        data = data[: args.conversations]
    logger.info("Running on %d conversations", len(data))

    args.output_dir.mkdir(parents=True, exist_ok=True)
    all_results: list[QAResult] = []

    # Incremental save path
    incr_path = args.output_dir / (args.output_name + ".incremental.jsonl")

    # Resume: load already-completed conversations from incremental file.
    # A conv counts as "complete" only if its QA count matches the dataset.
    # Partial convs get their rows dropped and are re-run from scratch.
    completed_convs: set[str] = set()
    if args.resume and incr_path.exists():
        expected_qa_counts: dict[str, int] = {}
        for e in data:
            sid = e.get("sample_id", "")
            qas = e.get("qa", [])
            if args.skip_adversarial:
                qas = [q for q in qas if q.get("category") != 5]
            expected_qa_counts[sid] = len(qas) if args.sample is None else min(args.sample, len(qas))

        by_conv: dict[str, list[dict]] = defaultdict(list)
        with open(incr_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    by_conv[entry["conversation_id"]].append(entry)
                except (json.JSONDecodeError, KeyError):
                    pass

        keep_entries: list[dict] = []
        for conv_id, entries in by_conv.items():
            expected = expected_qa_counts.get(conv_id, 0)
            if len(entries) >= expected and expected > 0:
                completed_convs.add(conv_id)
                keep_entries.extend(entries)
                for entry in entries:
                    try:
                        all_results.append(QAResult(**entry))
                    except TypeError:
                        pass
            else:
                logger.info("Dropping %d partial QA rows for %s (have %d / need %d)",
                            len(entries), conv_id, len(entries), expected)

        # Rewrite incremental file with only complete-conv rows
        with open(incr_path, "w", encoding="utf-8") as f:
            for entry in keep_entries:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        if completed_convs:
            logger.info("Resuming: %d conversations already done: %s",
                        len(completed_convs), ", ".join(sorted(completed_convs)))
    start_time = time.time()
    # Resume always appends: we rewrote incr_path with only complete-conv rows above.
    file_mode = "a" if args.resume else "w"
    with open(incr_path, file_mode, encoding="utf-8") as f:
        for entry in data:
            if entry.get("sample_id", "") in completed_convs:
                logger.info("Skipping %s (already completed)", entry.get("sample_id"))
                continue
            try:
                conv_results = process_conversation(
                    entry,
                    top_k=args.top_k,
                    sample_n=args.sample,
                    skip_adversarial=args.skip_adversarial,
                    budget=args.budget,
                    flush_file=f,
                    salience=args.salience,
                )
            except Exception as exc:
                logger.exception("Conversation %s failed: %s", entry.get("sample_id"), exc)
                continue
            all_results.extend(conv_results)
            # Periodic aggregate print
            agg = aggregate(all_results)
            logger.info(
                "Progress: %d QAs | overall mean score = %.3f",
                agg["overall"]["total"], agg["overall"]["mean_score"],
            )

    elapsed = time.time() - start_time
    agg = aggregate(all_results)

    report = {
        "benchmark": "LoCoMo (snap-research/locomo10)",
        "hippo_version": hippo_version,
        "judge_model": args.judge_model,
        "judge_prompt_template_standard": JUDGE_PROMPT_TEMPLATE,
        "judge_prompt_template_adversarial": JUDGE_PROMPT_ADVERSARIAL,
        "config": {
            "top_k": args.top_k,
            "budget": args.budget,
            "conversations_run": len(data),
            "sample_per_conv": args.sample,
            "skip_adversarial": args.skip_adversarial,
        },
        "elapsed_seconds": elapsed,
        "aggregate": agg,
        "per_qa": [asdict(r) for r in all_results],
    }
    out_path = args.output_dir / args.output_name
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    logger.info("Saved report to %s", out_path)
    logger.info("Overall score: %.3f (%d QAs, %.0fs)", agg["overall"]["mean_score"],
                agg["overall"]["total"], elapsed)
    print(json.dumps(agg, indent=2))


if __name__ == "__main__":
    main()
