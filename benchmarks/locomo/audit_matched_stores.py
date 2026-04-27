"""Audit LoCoMo store parity without running the Claude judge.

This cheap pre-scoring check builds fresh per-conversation stores, compares
stored memory counts, and probes whether the configured recall budget caps
top-k retrieval.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any

from run import CATEGORY_NAMES, collect_turns, load_dataset

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_HIGH_BUDGET = 1_000_000


def split_command(command: str) -> list[str]:
    command = command.strip()
    if len(command) >= 2 and command[0] == command[-1] and command[0] in {"'", '"'}:
        command = command[1:-1]
    return shlex.split(command, posix=(os.name != "nt"))


def parse_profile(raw: str) -> tuple[str, list[str]]:
    if "=" not in raw:
        raise ValueError(f'Expected --hippo-cmd value like label="node path/to/bin/hippo.js", got: {raw}')
    label, command = raw.split("=", 1)
    label = label.strip()
    parts = split_command(command.strip())
    if not label or not parts:
        raise ValueError(f"Invalid --hippo-cmd value: {raw}")
    return label, parts


def run_hippo(
    command: list[str],
    args: list[str],
    cwd: str,
    hippo_home: str,
    timeout: int = 60,
) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "HIPPO_HOME": hippo_home,
        "HOME": hippo_home,
        "USERPROFILE": hippo_home,
        "HIPPO_SKIP_AUTO_INTEGRATIONS": "1",
    }
    full_command = command + args
    if sys.platform == "win32":
        cmd: str | list[str] = subprocess.list2cmdline(full_command)
        shell = True
    else:
        cmd = full_command
        shell = False
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        shell=shell,
        timeout=timeout,
    )


def parse_json_stdout(stdout: str) -> Any:
    text = stdout.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
        if not starts:
            raise
        return json.loads(text[min(starts):])


def init_store(command: list[str], hippo_home: str) -> None:
    result = run_hippo(
        command,
        ["init", "--no-hooks", "--no-schedule", "--no-learn"],
        cwd=hippo_home,
        hippo_home=hippo_home,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"hippo init failed: {result.stderr.strip()}")


def remember_turn(command: list[str], hippo_home: str, text: str, tags: list[str]) -> str:
    args = ["remember", text]
    for tag in tags:
        args.extend(["--tag", tag])
    result = run_hippo(command, args, cwd=hippo_home, hippo_home=hippo_home, timeout=30)
    if result.returncode != 0:
        return "failed"
    first_line = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
    if first_line.startswith("Skipped"):
        return "skipped"
    if "Remembered [" in first_line:
        return "stored"
    return "other"


def export_entries(command: list[str], hippo_home: str) -> list[dict[str, Any]]:
    output_path = Path(hippo_home) / "audit-export.json"
    result = run_hippo(
        command,
        ["export", str(output_path)],
        cwd=hippo_home,
        hippo_home=hippo_home,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"hippo export failed: {result.stderr.strip()}")
    return json.loads(output_path.read_text(encoding="utf-8"))


def recall_count(command: list[str], hippo_home: str, question: str, budget: int) -> int:
    result = run_hippo(
        command,
        ["recall", question, "--json", "--budget", str(budget)],
        cwd=hippo_home,
        hippo_home=hippo_home,
        timeout=120,
    )
    if result.returncode != 0:
        return 0
    data = parse_json_stdout(result.stdout)
    if not isinstance(data, dict):
        return 0
    results = data.get("results", [])
    return len(results) if isinstance(results, list) else 0


def audit_conversation(
    command: list[str],
    conv_entry: dict[str, Any],
    top_k: int,
    budget: int,
    high_budget: int,
    sample_qa: int,
    max_turns: int | None,
    keep_store: bool,
) -> dict[str, Any]:
    sample_id = conv_entry["sample_id"]
    hippo_home = tempfile.mkdtemp(prefix=f"hippo_locomo_audit_{sample_id}_")
    try:
        init_store(command, hippo_home)
        all_turns = collect_turns(conv_entry["conversation"])
        turns = all_turns[:max_turns] if max_turns is not None else all_turns
        outcomes = Counter()
        for session_n, dia_id, speaker, text in turns:
            tags = [
                f"conv:{sample_id}",
                f"session:{session_n}",
                f"speaker:{speaker}",
                f"dia:{dia_id}",
            ]
            outcomes[remember_turn(command, hippo_home, text, tags)] += 1

        entries = export_entries(command, hippo_home)
        layer_counts = Counter(str(entry.get("layer", "unknown")) for entry in entries)
        probes = []
        for qa in conv_entry.get("qa", [])[:sample_qa]:
            question = qa.get("question", "")
            configured_count = recall_count(command, hippo_home, question, budget)
            high_count = recall_count(command, hippo_home, question, high_budget)
            category = qa.get("category", 0)
            probes.append({
                "question": question,
                "category": category,
                "category_name": CATEGORY_NAMES.get(category, f"cat{category}"),
                "configured_count": configured_count,
                "high_budget_count": high_count,
                "budget_capped": configured_count < top_k <= high_count,
            })

        return {
            "conversation_id": sample_id,
            "source_turns": len(all_turns),
            "expected_turns": len(turns),
            "truncated": len(turns) < len(all_turns),
            "remember_outcomes": dict(outcomes),
            "stored_entries": len(entries),
            "layer_counts": dict(layer_counts),
            "qa_probes": probes,
            "store_path": hippo_home if keep_store else None,
        }
    finally:
        if not keep_store:
            shutil.rmtree(hippo_home, ignore_errors=True)


def summarise_profile(conversations: list[dict[str, Any]]) -> dict[str, Any]:
    total_expected = sum(c["expected_turns"] for c in conversations)
    total_stored = sum(c["stored_entries"] for c in conversations)
    capped = sum(1 for c in conversations for p in c["qa_probes"] if p["budget_capped"])
    return {
        "conversations": len(conversations),
        "expected_turns": total_expected,
        "stored_entries": total_stored,
        "stored_delta_vs_expected": total_stored - total_expected,
        "budget_capped_probes": capped,
    }


def compare_profiles(profiles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(profiles) < 2:
        return []
    baseline = profiles[0]
    baseline_by_conv = {c["conversation_id"]: c for c in baseline["conversations"]}
    comparisons = []
    for profile in profiles[1:]:
        conv_diffs = []
        for conv in profile["conversations"]:
            base_conv = baseline_by_conv.get(conv["conversation_id"])
            if not base_conv:
                continue
            delta = conv["stored_entries"] - base_conv["stored_entries"]
            if delta != 0:
                conv_diffs.append({
                    "conversation_id": conv["conversation_id"],
                    "stored_delta": delta,
                    "baseline_stored": base_conv["stored_entries"],
                    "candidate_stored": conv["stored_entries"],
                })
        comparisons.append({
            "baseline": baseline["label"],
            "candidate": profile["label"],
            "stored_delta": profile["summary"]["stored_entries"] - baseline["summary"]["stored_entries"],
            "conversations_with_stored_delta": conv_diffs,
            "candidate_budget_capped_probes": profile["summary"]["budget_capped_probes"],
        })
    return comparisons


def main() -> None:
    parser = argparse.ArgumentParser(description="Cheap LoCoMo matched-store audit without judge scoring.")
    parser.add_argument("--data", type=Path, default=Path(__file__).with_name("data") / "locomo10.json")
    parser.add_argument(
        "--hippo-cmd",
        action="append",
        default=[],
        help="Repeatable LABEL=COMMAND, for example 'current=node C:/repo/bin/hippo.js'",
    )
    parser.add_argument("--max-conversations", type=int, default=1)
    parser.add_argument(
        "--max-turns",
        type=int,
        default=None,
        help="Limit turns ingested per conversation for fast smoke checks.",
    )
    parser.add_argument("--sample-qa", type=int, default=3)
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--budget", type=int, default=4000)
    parser.add_argument("--high-budget", type=int, default=DEFAULT_HIGH_BUDGET)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--keep-stores", action="store_true")
    args = parser.parse_args()

    default_cmd = f"current=node {(REPO_ROOT / 'bin' / 'hippo.js').as_posix()}"
    profile_specs = args.hippo_cmd or [default_cmd]
    profiles_to_run = [parse_profile(raw) for raw in profile_specs]
    data = load_dataset(args.data)[: args.max_conversations]

    profiles = []
    for label, command in profiles_to_run:
        version_home = tempfile.mkdtemp(prefix="hippo_locomo_version_")
        try:
            version_result = run_hippo(command, ["--version"], cwd=str(REPO_ROOT), hippo_home=version_home)
            version = version_result.stdout.strip() or "unknown"
        finally:
            shutil.rmtree(version_home, ignore_errors=True)

        conversations = [
            audit_conversation(
                command,
                entry,
                top_k=args.top_k,
                budget=args.budget,
                high_budget=args.high_budget,
                sample_qa=args.sample_qa,
                max_turns=args.max_turns,
                keep_store=args.keep_stores,
            )
            for entry in data
        ]
        profiles.append({
            "label": label,
            "command": command,
            "version": version,
            "summary": summarise_profile(conversations),
            "conversations": conversations,
        })

    report = {
        "benchmark": "LoCoMo matched-store audit",
        "data": str(args.data),
        "max_conversations": args.max_conversations,
        "max_turns": args.max_turns,
        "sample_qa": args.sample_qa,
        "top_k": args.top_k,
        "budget": args.budget,
        "high_budget": args.high_budget,
        "profiles": profiles,
        "comparisons": compare_profiles(profiles),
    }

    text = json.dumps(report, indent=2, ensure_ascii=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
        print(f"Wrote {args.output}")
    print(text)

    has_failed_ingest = any(
        c["remember_outcomes"].get("failed", 0) > 0
        for profile in profiles
        for c in profile["conversations"]
    )
    has_budget_cap = any(profile["summary"]["budget_capped_probes"] > 0 for profile in profiles)
    has_store_delta = any(cmp["stored_delta"] != 0 for cmp in report["comparisons"])
    if has_failed_ingest or has_budget_cap or has_store_delta:
        sys.exit(1)


if __name__ == "__main__":
    main()
