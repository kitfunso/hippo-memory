"""Run the LoCoMo benchmark against hippo-memory.

For each LoCoMo conversation:
  1. Create a fresh HIPPO_HOME.
  2. hippo init.
  3. Ingest every session turn as a memory via `hippo remember`.
  4. For every QA in that conversation, run `hippo recall --json`.
  5. Score the top-K memories with an LLM judge or deterministic gold
     evidence dia_id recall.

Outputs a single JSON at results/hippo-v{version}.json with per-QA scores +
overall + per-category aggregates.

Honors the brief's non-negotiables:
  - Uses globally installed `hippo` CLI.
  - Fresh HIPPO_HOME per conversation (no cross-conversation leakage).
  - No hippo source changes.
  - Score mode, judge backend, and model id recorded in the output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable

from tqdm import tqdm

logger = logging.getLogger(__name__)

# --- Configuration ---

JUDGE_MODEL = "claude-opus-4-7"  # label for the `claude -p` CLI used; actual model governed by the CLI install
OPENAI_JUDGE_MODEL = "gpt-4.1-mini"
RECALL_PREFLIGHT_BUDGET = 1_000_000
VERDICT_TOKENS = ("equivalent", "partial", "wrong", "none", "weak", "strong")
FATAL_JUDGE_MARKERS = (
    "monthly usage limit",
    "insufficient_quota",
    "invalid_api_key",
    "billing",
)


class JudgeError(RuntimeError):
    """Raised when the external Claude judge fails to return a usable verdict."""

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
    gold_evidence: list[str] = field(default_factory=list)
    gold_evidence_unmatched: list[str] = field(default_factory=list)
    retrieved_dia_ids: list[str] = field(default_factory=list)
    evidence_hits: list[str] = field(default_factory=list)
    evidence_recall: float | None = None
    evidence_precision: float | None = None
    scored: bool = True

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
    # Override the hippo binary via HIPPO_BIN. This may be either a single
    # executable path or a command string such as `node C:/repo/bin/hippo.js`.
    hippo_bin = os.environ.get("HIPPO_BIN")
    cmd = shlex.split(hippo_bin) if hippo_bin else ["hippo"]
    cmd += args
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
    # HIPPO_RECALL_EXTRA_ARGS lets feature branches A/B compare on LoCoMo
    # (e.g. HIPPO_RECALL_EXTRA_ARGS="--evc-adaptive"). Default empty.
    extra = shlex.split(os.environ.get("HIPPO_RECALL_EXTRA_ARGS", ""))
    try:
        result = run_hippo(
            ["recall", query, "--json", "--budget", str(budget), *extra],
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


def assert_recall_budget_not_capped(
    hippo_home: str,
    qa_list: list[dict[str, Any]],
    top_k: int,
    budget: int,
) -> None:
    if budget >= RECALL_PREFLIGHT_BUDGET or top_k <= 0 or not qa_list:
        return

    probe = next((qa.get("question", "") for qa in qa_list if qa.get("question", "")), "")
    if not probe:
        return

    configured = hippo_recall(hippo_home, probe, budget=budget)
    high_budget = hippo_recall(hippo_home, probe, budget=RECALL_PREFLIGHT_BUDGET)
    if len(configured) < top_k <= len(high_budget):
        raise RuntimeError(
            "LoCoMo recall preflight failed: configured --budget "
            f"{budget} returned {len(configured)} memories for top_k={top_k}, "
            f"but budget {RECALL_PREFLIGHT_BUDGET} returned {len(high_budget)}. "
            "Raise --budget before scoring so the harness is not budget-capped."
        )


def format_memories_for_judge(memories: list[dict[str, Any]], top_k: int) -> str:
    if not memories:
        return "  (no memories returned)"
    lines = []
    for i, m in enumerate(memories[:top_k], 1):
        content = m.get("content", "").replace("\n", " ").strip()
        lines.append(f"  {i}. {content}")
    return "\n".join(lines)


def normalize_dia_id(value: Any) -> str:
    text = str(value).strip()
    match = re.fullmatch(r"D(\d+):0*(\d+)", text, flags=re.IGNORECASE)
    if match:
        return f"D{int(match.group(1))}:{int(match.group(2))}"
    return text


def normalize_evidence_refs(values: Any) -> list[str]:
    refs: list[str] = []
    if not isinstance(values, list):
        return refs
    for value in values:
        text = str(value)
        matches = re.finditer(r"D(?:(\d+):0*(\d+)|:(\d+):0*(\d+))", text, flags=re.IGNORECASE)
        for match in matches:
            session = match.group(1) or match.group(3)
            turn = match.group(2) or match.group(4)
            ref = normalize_dia_id(f"D{session}:{turn}")
            if ref and ref not in refs:
                refs.append(ref)
    return refs


def dia_ids_from_memory(memory: dict[str, Any]) -> list[str]:
    dia_ids: list[str] = []
    raw_dia_ids = memory.get("dia_ids", [])
    if isinstance(raw_dia_ids, list):
        for raw in raw_dia_ids:
            dia_id = normalize_dia_id(raw)
            if dia_id and dia_id not in dia_ids:
                dia_ids.append(dia_id)
    tags = memory.get("tags", [])
    if isinstance(tags, list):
        for tag in tags:
            text = str(tag)
            if text.startswith("dia:"):
                dia_id = normalize_dia_id(text.removeprefix("dia:"))
                if dia_id and dia_id not in dia_ids:
                    dia_ids.append(dia_id)
    return dia_ids


def summarize_memory(memory: dict[str, Any]) -> dict[str, Any]:
    tags = memory.get("tags", [])
    if not isinstance(tags, list):
        tags = []
    dia_ids = dia_ids_from_memory(memory)
    return {
        "content": memory.get("content", ""),
        "score": memory.get("score", 0.0),
        "tags": [str(tag) for tag in tags],
        "dia_ids": dia_ids,
    }


def score_evidence_overlap(
    gold_evidence: list[str],
    memories: list[dict[str, Any]],
    top_k: int,
) -> tuple[str, float, list[str], list[str], float | None, float | None, bool]:
    gold = normalize_evidence_refs(gold_evidence)
    retrieved: list[str] = []
    for memory in memories[:top_k]:
        for dia_id in dia_ids_from_memory(memory):
            if dia_id not in retrieved:
                retrieved.append(dia_id)

    if not gold:
        return "evidence_unscored", 0.0, retrieved, [], None, None, False

    gold_set = set(gold)
    hits = [dia_id for dia_id in retrieved if dia_id in gold_set]
    recall = len(set(hits)) / len(gold_set)
    precision = len(set(hits)) / len(retrieved) if retrieved else 0.0
    if recall >= 1.0:
        verdict = "evidence_full"
    elif hits:
        verdict = "evidence_partial"
    else:
        verdict = "evidence_miss"
    return verdict, recall, retrieved, hits, recall, precision, True


def extract_verdict(text: str) -> str | None:
    """Return the first supported verdict token near the start of judge output."""
    words = text.strip().lower().split()
    for token in VERDICT_TOKENS:
        if words and token in words[:5]:
            return token
    return None


def is_fatal_judge_error(detail: str) -> bool:
    lowered = detail.lower()
    return any(marker in lowered for marker in FATAL_JUDGE_MARKERS)


def judge_with_claude_cli(prompt: str, timeout: int = 60, max_attempts: int = 4) -> str:
    """Invoke `claude -p` as the judge. Returns the one-word verdict.

    Retries on transient failures (rc!=0, timeout, no-usable-verdict) with
    exponential backoff. The `claude -p` CLI fails intermittently under
    parallel load, so a single failure should not abort the whole run.
    """
    last_err: Exception | None = None
    for attempt in range(max_attempts):
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
        except subprocess.TimeoutExpired as exc:
            last_err = JudgeError("judge timed out")
        else:
            if result.returncode != 0:
                detail = "\n".join(part for part in (result.stderr.strip(), result.stdout.strip()) if part)
                last_err = JudgeError(f"judge rc={result.returncode}: {detail[:200]}")
                if "monthly usage limit" in detail.lower():
                    raise last_err
            else:
                verdict = extract_verdict(result.stdout)
                if verdict:
                    return verdict
                last_err = JudgeError(f"judge returned no usable verdict: {result.stdout[:200]}")
        if attempt < max_attempts - 1:
            time.sleep(2 ** attempt)  # 1, 2, 4 seconds
    raise last_err if last_err else JudgeError("judge failed (unknown)")


def extract_openai_text(data: dict[str, Any]) -> str:
    if isinstance(data.get("output_text"), str):
        return data["output_text"]
    chunks: list[str] = []
    for item in data.get("output", []):
        if not isinstance(item, dict):
            continue
        for content in item.get("content", []):
            if not isinstance(content, dict):
                continue
            if content.get("type") in {"output_text", "text"} and isinstance(content.get("text"), str):
                chunks.append(content["text"])
    return "\n".join(chunks)


def judge_with_openai(
    prompt: str,
    model: str,
    base_url: str,
    timeout: int = 60,
    max_attempts: int = 4,
) -> str:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise JudgeError("openai judge requires OPENAI_API_KEY")

    url = base_url.rstrip("/") + "/responses"
    payload = {
        "model": model,
        "input": prompt,
        "max_output_tokens": 8,
        "store": False,
    }
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    last_err: Exception | None = None
    for attempt in range(max_attempts):
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                response_text = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            last_err = JudgeError(f"openai judge http {exc.code}: {detail[:500]}")
            if exc.code in {400, 401, 403} or is_fatal_judge_error(detail):
                raise last_err
        except urllib.error.URLError as exc:
            last_err = JudgeError(f"openai judge url error: {exc}")
        except TimeoutError as exc:
            last_err = JudgeError("openai judge timed out")
        else:
            try:
                data = json.loads(response_text)
            except json.JSONDecodeError as exc:
                last_err = JudgeError(f"openai judge returned non-json: {response_text[:200]}")
            else:
                verdict = extract_verdict(extract_openai_text(data))
                if verdict:
                    return verdict
                last_err = JudgeError(f"openai judge returned no usable verdict: {response_text[:500]}")
        if attempt < max_attempts - 1:
            time.sleep(2 ** attempt)
    raise last_err if last_err else JudgeError("openai judge failed (unknown)")


def judge_with_command(prompt: str, command: str, timeout: int = 60, max_attempts: int = 4) -> str:
    last_err: Exception | None = None
    for attempt in range(max_attempts):
        try:
            result = subprocess.run(
                command,
                input=prompt,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                shell=True,
            )
        except subprocess.TimeoutExpired as exc:
            last_err = JudgeError("command judge timed out")
        else:
            detail = "\n".join(part for part in (result.stderr.strip(), result.stdout.strip()) if part)
            if result.returncode != 0:
                last_err = JudgeError(f"command judge rc={result.returncode}: {detail[:500]}")
                if is_fatal_judge_error(detail):
                    raise last_err
            else:
                verdict = extract_verdict(result.stdout)
                if verdict:
                    return verdict
                last_err = JudgeError(f"command judge returned no usable verdict: {result.stdout[:200]}")
        if attempt < max_attempts - 1:
            time.sleep(2 ** attempt)
    raise last_err if last_err else JudgeError("command judge failed (unknown)")


def judge_prompt(
    prompt: str,
    backend: str,
    model: str,
    command: str | None,
    openai_base_url: str,
    timeout: int,
) -> str:
    if backend == "claude-cli":
        return judge_with_claude_cli(prompt, timeout=timeout)
    if backend == "openai":
        return judge_with_openai(prompt, model=model, base_url=openai_base_url, timeout=timeout)
    if backend == "command":
        if not command:
            raise JudgeError("command judge requires --judge-command")
        return judge_with_command(prompt, command=command, timeout=timeout)
    raise JudgeError(f"unknown judge backend: {backend}")


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
    judge_backend: str = "claude-cli",
    judge_model: str = JUDGE_MODEL,
    judge_command: str | None = None,
    openai_base_url: str = "https://api.openai.com/v1",
    judge_timeout: int = 60,
    score_mode: str = "judge",
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
        seed = int.from_bytes(hashlib.sha256(sample_id.encode("utf-8")).digest()[:4], "big")
        rng = random.Random(0xC0C0 ^ seed)
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
        valid_dia_ids = {dia_id for _, dia_id, _, _ in turns if dia_id}
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

        assert_recall_budget_not_capped(hippo_home, qa_list, top_k, budget)

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
            evidence_refs = normalize_evidence_refs(qa.get("evidence", []))
            gold_evidence = [ref for ref in evidence_refs if ref in valid_dia_ids]
            gold_evidence_unmatched = [ref for ref in evidence_refs if ref not in valid_dia_ids]

            memories = hippo_recall(hippo_home, question, budget=budget)
            retrieved_dia_ids: list[str] = []
            evidence_hits: list[str] = []
            evidence_recall: float | None = None
            evidence_precision: float | None = None
            scored = True

            if score_mode == "evidence":
                (
                    verdict,
                    score,
                    retrieved_dia_ids,
                    evidence_hits,
                    evidence_recall,
                    evidence_precision,
                    scored,
                ) = score_evidence_overlap(gold_evidence, memories, top_k)
            else:
                mem_block = format_memories_for_judge(memories, top_k)

                template = JUDGE_PROMPT_ADVERSARIAL if is_adv else JUDGE_PROMPT_TEMPLATE
                prompt = template.format(
                    question=question, expected=expected, memories=mem_block, k=top_k
                )
                verdict = judge_prompt(
                    prompt,
                    backend=judge_backend,
                    model=judge_model,
                    command=judge_command,
                    openai_base_url=openai_base_url,
                    timeout=judge_timeout,
                )
                score = score_verdict(verdict, is_adv)
                for memory in memories[:top_k]:
                    for dia_id in dia_ids_from_memory(memory):
                        if dia_id not in retrieved_dia_ids:
                            retrieved_dia_ids.append(dia_id)

            qa_result = QAResult(
                conversation_id=sample_id,
                qa_index=i,
                question=question,
                expected_answer=expected,
                category=category,
                category_name=CATEGORY_NAMES.get(category, f"cat{category}"),
                is_adversarial=is_adv,
                top_k_memories=[summarize_memory(m) for m in memories[:top_k]],
                judge_verdict=verdict,
                score=score,
                gold_evidence=gold_evidence,
                gold_evidence_unmatched=gold_evidence_unmatched,
                retrieved_dia_ids=retrieved_dia_ids,
                evidence_hits=evidence_hits,
                evidence_recall=evidence_recall,
                evidence_precision=evidence_precision,
                scored=scored,
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
    scored_results = [r for r in results if getattr(r, "scored", True)]
    total = len(scored_results)
    if total == 0:
        return {"overall": {"total": 0, "score": 0.0}, "per_category": {}}

    overall_score = sum(r.score for r in scored_results) / total

    by_cat: dict[int, list[QAResult]] = defaultdict(list)
    for r in scored_results:
        by_cat[r.category].append(r)
    per_cat = {}
    for cat, rs in sorted(by_cat.items()):
        per_cat[CATEGORY_NAMES.get(cat, f"cat{cat}")] = {
            "total": len(rs),
            "mean_score": sum(r.score for r in rs) / len(rs),
            "n_equivalent": sum(1 for r in rs if r.score == 1.0),
            "n_partial": sum(1 for r in rs if 0.0 < r.score < 1.0),
            "n_wrong": sum(1 for r in rs if r.score == 0.0),
            "n_unscored": sum(1 for r in results if r.category == cat and not getattr(r, "scored", True)),
        }

    return {
        "overall": {
            "total": total,
            "mean_score": overall_score,
            "n_equivalent": sum(1 for r in scored_results if r.score == 1.0),
            "n_partial": sum(1 for r in scored_results if 0.0 < r.score < 1.0),
            "n_wrong": sum(1 for r in scored_results if r.score == 0.0),
            "n_unscored": len(results) - total,
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
    parser.add_argument("--score-mode", choices=["judge", "evidence"], default="judge",
                        help="judge uses an LLM; evidence scores deterministic gold dia_id recall@K.")
    parser.add_argument("--judge-backend", choices=["claude-cli", "openai", "command"],
                        default="claude-cli")
    parser.add_argument("--judge-model", type=str, default=None,
                        help="Judge model label/name. Defaults depend on --judge-backend.")
    parser.add_argument("--judge-command", type=str, default=None,
                        help="Shell command for --judge-backend command; prompt is sent on stdin.")
    parser.add_argument("--judge-timeout", type=int, default=60)
    parser.add_argument("--openai-base-url", type=str,
                        default=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"))
    parser.add_argument("--salience", action="store_true",
                        help="Enable pineal salience gate (default off, see hippo_init docstring).")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    if args.score_mode == "evidence":
        args.judge_model = args.judge_model or "none"
    elif args.judge_model is None:
        if args.judge_backend == "openai":
            args.judge_model = OPENAI_JUDGE_MODEL
        elif args.judge_backend == "command":
            args.judge_model = "command"
        else:
            args.judge_model = JUDGE_MODEL
    if args.score_mode == "judge" and args.judge_backend == "command" and not args.judge_command:
        parser.error("--judge-backend command requires --judge-command")

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    # Verify hippo version through the same command path used by the run.
    version_home = tempfile.mkdtemp(prefix="hippo_locomo_version_")
    try:
        v_result = run_hippo(["--version"], cwd=str(Path.cwd()), hippo_home=version_home, timeout=60)
        hippo_version = v_result.stdout.strip() or "unknown"
    finally:
        shutil.rmtree(version_home, ignore_errors=True)
    logger.info("hippo --version: %s", hippo_version)

    if args.output_name is None and args.score_mode == "evidence":
        args.output_name = f"hippo-v{hippo_version}-evidence.json"
    elif args.output_name is None:
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
    failed_conversations: list[dict[str, str]] = []
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
                    judge_backend=args.judge_backend,
                    judge_model=args.judge_model,
                    judge_command=args.judge_command,
                    openai_base_url=args.openai_base_url,
                    judge_timeout=args.judge_timeout,
                    score_mode=args.score_mode,
                )
            except Exception as exc:
                logger.exception("Conversation %s failed: %s", entry.get("sample_id"), exc)
                failed_conversations.append({
                    "conversation_id": entry.get("sample_id", ""),
                    "error": str(exc),
                })
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
            "score_mode": args.score_mode,
            "top_k": args.top_k,
            "budget": args.budget,
            "recall_preflight_budget": RECALL_PREFLIGHT_BUDGET,
            "conversations_run": len(data),
            "sample_per_conv": args.sample,
            "skip_adversarial": args.skip_adversarial,
            "judge_backend": args.judge_backend,
            "judge_timeout": args.judge_timeout,
            "judge_command_configured": args.judge_backend == "command",
            "openai_base_url": args.openai_base_url if args.judge_backend == "openai" else None,
        },
        "elapsed_seconds": elapsed,
        "complete": not failed_conversations,
        "failed_conversations": failed_conversations,
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
    if failed_conversations:
        logger.error("Run incomplete: %d conversations failed", len(failed_conversations))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
