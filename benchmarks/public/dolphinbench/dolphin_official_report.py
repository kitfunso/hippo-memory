"""The smoke gates, the run report and the published-answer rejudge for dolphin_official.py."""
from __future__ import annotations

import gzip
import json
import logging
import math
import os
import re
import shutil
import sqlite3
import tempfile
import urllib.request
from argparse import Namespace
from collections import Counter
from datetime import datetime
from pathlib import Path

from dolphin_home import BENCH
from dolphin_official import (
    CLAUDE_VERSION,
    HOMES,
    INGEST_UID,
    JUDGE_MODEL,
    MODEL,
    PROVIDER,
    SANDBOX,
    TOTAL_TURNS,
    Paths,
    as_user,
    corpus,
    hippo_dbs,
    ingest_run,
    init_event,
    load_setup,
    pick_token,
    sha256_file,
    token_headers,
    use_judge,
    use_official,
    utc,
)

log = logging.getLogger("dolphin_official")
PUBLISHED_ROWS = {"builtin": 158, "mem0": 194, "honcho": 215}  # of 600, the official leaderboard
EVIDENCE = BENCH / "evidence"
DIGEST_TAG = "session-digest"
AGENT_SOURCES = {"cli", "stdin", "mcp"}
STOPWORDS = frozenset((
    "about after again along also always another around because before being below between could doing during "
    "every going great having maybe might never other really right should since something still their there "
    "these thing things think those though today tomorrow through under until where which while would yesterday"
).split())
GATES = {"user_facts_kept": 5, "hook_p95_ms": 2500, "hook_timeouts": 0}


def p95(values: list[float]) -> float | None:
    values = sorted(values)
    return values[min(len(values) - 1, math.ceil(0.95 * len(values)) - 1)] if values else None


def transcript_hooks(paths: list[Path]) -> dict:
    """Hook attachments Claude Code writes into its transcripts: durations by event, timeouts and errors."""
    durations: dict[str, list[int]] = {}
    counts = Counter()
    for path in paths:
        if not path.is_file():
            counts["missing_transcripts"] += 1
            continue
        for line in path.read_text(errors="replace").splitlines():
            attachment = json.loads(line).get("attachment") if line.startswith("{") else None
            if not isinstance(attachment, dict) or not str(attachment.get("type", "")).startswith("hook_"):
                continue
            kind, event = attachment["type"], attachment.get("hookEvent", "?")
            counts[kind] += 1
            if isinstance(attachment.get("durationMs"), (int, float)):
                durations.setdefault(event, []).append(attachment["durationMs"])
    return {"durations_ms": durations, "counts": dict(counts)}


def memory_rows(home: Path) -> list[dict]:
    """Every memory row of both stores, read from copies so root never touches the live files."""
    rows = []
    with tempfile.TemporaryDirectory() as raw:
        for index, db in enumerate(hippo_dbs(home)):
            copy = Path(raw) / f"{index}.db"
            for suffix in ("", "-wal"):
                if Path(f"{db}{suffix}").exists():
                    shutil.copyfile(f"{db}{suffix}", f"{copy}{suffix}")
            connection = sqlite3.connect(copy)
            tables = {name for (name,) in connection.execute("select name from sqlite_master where type='table'")}
            vectors = (dict(connection.execute("select memory_id, model from memory_vectors").fetchall())
                       if "memory_vectors" in tables else {})
            for memory_id, source, tags, content in connection.execute(
                    "select id, source, tags_json, content from memories"):
                rows.append({"store": str(db.relative_to(home)), "id": memory_id, "source": source,
                             "digest": DIGEST_TAG in tags, "content": content, "vector": vectors.get(memory_id)})
            connection.close()
    return rows


def memory_summary(rows: list[dict]) -> dict:
    def group(row: dict) -> str:
        if row["digest"]:
            return "digest"
        return "agent_remember" if row["source"] in AGENT_SOURCES or row["source"].startswith("mcp") else "capture"
    stores = Counter(row["store"] for row in rows)
    # hippo writes session digests without an embed call (src/api/memories/session-digest.ts), so they sit apart.
    embedded = [row for row in rows if not row["digest"]]
    return {"total": len(rows), "by_group": dict(Counter(map(group, rows))),
            "by_source": dict(Counter(row["source"] for row in rows)), "by_store": dict(stores),
            "vectors": {store: sum(1 for row in rows if row["store"] == store and row["vector"]) for store in stores},
            "vector_models": dict(Counter(row["vector"] for row in rows if row["vector"])),
            "digests_with_vector": sum(bool(row["vector"]) for row in rows if row["digest"]),
            "one_vector_per_memory": all(row["vector"] for row in embedded) and bool(embedded)}


def key_words(text: str) -> set[str]:
    return {word.lower() for word in re.findall(r"[A-Za-z][A-Za-z'-]{4,}", text)} - STOPWORDS


def user_facts(messages: list, rows: list[dict]) -> dict:
    """A message is kept when one non-digest memory holds at least min(3, n) of its n key words."""
    memories = [key_words(row["content"]) for row in rows if not row["digest"]]
    kept = []
    for message in messages:
        words = key_words(message.content)
        need = min(3, len(words))
        best = max((len(words & memory) for memory in memories), default=0)
        kept.append({"source_id": message.source_id, "words": len(words), "best_overlap": best,
                     "kept": bool(words) and best >= need})
    return {"kept": sum(row["kept"] for row in kept), "of": len(kept), "messages": kept}


def probe_home(paths: Paths) -> Paths:
    """A copy of the smoke home for the read-only probes, so they cannot touch the store the smoke measured."""
    probe = Paths(paths.run, f"{paths.persona}-probe")
    shutil.rmtree(probe.root, ignore_errors=True)
    shutil.copytree(paths.home, probe.home, symlinks=True)
    for path in (probe.home, *probe.home.rglob("*")):
        os.chown(path, INGEST_UID, INGEST_UID, follow_symlinks=False)
    return probe


def in_sandbox(probe: Paths, setup: dict, command: list[str]) -> dict:
    env = {"PATH": os.environ["PATH"], "LANG": "C.UTF-8", "HOME": str(probe.home), "HIPPO_READ_ONLY": "1",
           "HIPPO_HOME": str(probe.home / ".hippo"), "HIPPO_MODEL_CACHE": setup["models"]["dir"]}
    done = as_user(INGEST_UID, ["/usr/bin/python3", str(SANDBOX), "turn", "--", *command], env=env,
                   cwd=probe.project, timeout=900)
    lines = [line for line in done.stdout.splitlines() if line.startswith("{")]
    return json.loads(lines[-1]) if done.returncode == 0 and lines else {"error": done.stderr[-800:]}


def recall_probes(paths: Paths, setup: dict, facts: dict, messages: list, token: str) -> dict:
    """Project-store recall twice on a read-only copy: one direct MCP call, one Claude Code turn that asks for it."""
    best = max((row for row in facts["messages"] if row["kept"]), key=lambda row: row["words"], default=None)
    if best is None:
        return {"passed": False, "reason": "no kept message to recall"}
    content = next(m.content for m in messages if m.source_id == best["source_id"])
    words = sorted({word for word in key_words(content) if word.isalpha()}, key=lambda w: (len(w), w))[-4:]
    query = " ".join(words)
    probe = probe_home(paths)
    plugin = setup["plugin"]["dir"]
    direct = in_sandbox(probe, setup, ["/usr/bin/python3", str(SANDBOX), "mcp", plugin, "hippo-memory",
                                       "hippo_recall", json.dumps({"query": query})])
    hits = sum(word in direct.get("result", "").lower() for word in words)
    hook = json.loads((Path(plugin) / "hooks" / "hooks.json").read_text())["hooks"]["UserPromptSubmit"][0]
    latency = in_sandbox(probe, setup, ["/usr/bin/python3", str(SANDBOX), "repeat", "10", "--", "/bin/sh", "-c",
                                        hook["hooks"][0]["command"]])
    from harness.claude_driver import run_claude
    from harness.claude_plugin_setup import configure_plugin
    from reference.runtimes.claude_code import child_environment
    wiring = configure_plugin(PROVIDER, probe.home, probe.project, Path(plugin),
                              {"model_cache": setup["models"]["dir"]})
    env = {**child_environment(PROVIDER, str(probe.home), wiring["env"], {"CLAUDE_CODE_OAUTH_TOKEN": token}),
           "HIPPO_READ_ONLY": "1"}
    result = run_claude(
        f"Use the hippo_recall tool with query '{query}' and reply with exactly what it returns.", timeout=900,
        claude_command=["/usr/bin/python3", str(SANDBOX), "turn", "--", "claude"], env=env,
        claude_config_dir=probe.home / ".claude", allowed_mcp_tools=["mcp__plugin_hippo-memory_hippo-memory__*"],
        cwd=probe.project, model=MODEL, plugin_directories=wiring["plugin_dirs"], persist_session=True,
        native_memory_mode="seed", native_memory_dir=probe.home / ".claude" / "auto-memory",
        builtin_tools=["Read", "Write", "Edit", "Bash", "Skill", "ToolSearch"], permission_mode="bypassPermissions",
        run_as_user=INGEST_UID, run_as_group=INGEST_UID)
    called = any(call["tool"].endswith("__hippo_recall") for call in result.tool_calls)
    agent_hits = sum(word in result.response_text.lower() for word in words)
    return {"query": query, "source_id": best["source_id"], "direct_tools": direct.get("tools"),
            "direct_hits": hits, "agent_ok": result.ok, "agent_called_recall": called, "agent_hits": agent_hits,
            "agent_error": result.error, "agent_mcp_servers": init_event(result.stdout).get("mcp_servers"),
            "direct_result": direct.get("result", direct.get("error", ""))[:1500],
            "agent_response": result.response_text[:1500],
            "user_prompt_hook_seconds": latency.get("seconds"),
            "passed": hits >= 2 and result.ok and called and agent_hits >= 2}


def projection(journal: list[dict], before: list[dict], after: list[dict]) -> dict:
    """Wall time, token use and weekly-limit use per turn, scaled to the full 13,539-turn history."""
    turns = len(journal)
    usage = Counter()
    for row in journal:
        usage.update({key: value for key, value in (row.get("usage") or {}).items() if isinstance(value, (int, float))})
    seconds = sum(row["seconds"] for row in journal)
    tokens = {row.get("token") for row in journal}
    windows = {}
    for name in tokens:
        old = next((row for row in before if row.get("name") == name), {})
        new = next((row for row in after if row.get("name") == name), {})
        for window in ("7d", "5h"):
            start, end = (row.get(f"{window}-utilization") for row in (old, new))
            if start is not None and end is not None:
                used = float(end) - float(start)
                windows[f"{name}:{window}"] = {"used": used, "per_turn": used / turns,
                                               "full_run_windows": used / turns * TOTAL_TURNS}
    return {"turns": turns, "seconds_per_turn": seconds / turns if turns else None,
            "usage_per_turn": {key: value / turns for key, value in usage.items()},
            "full_run": {"turns": TOTAL_TURNS, "hours": seconds / turns * TOTAL_TURNS / 3600 if turns else None,
                         "usage": {key: value / turns * TOTAL_TURNS for key, value in usage.items()}},
            "rate_limit": windows}


def smoke_stage(args: Namespace) -> int:
    setup = load_setup()
    paths = Paths(args.run, args.persona)
    _, before, _ = token_headers(args.agent)
    receipt = ingest_run(args, total=args.limit)
    _, after, _ = token_headers(args.agent)
    from reference.runtimes.claude_code import load_morgan_source_messages
    messages = [m for m in load_morgan_source_messages(corpus(args.persona))[0] if m.source_id in receipt["completed"]]
    journal = [json.loads(line) for line in (paths.controller / "journal.jsonl").read_text().splitlines()]
    rows = memory_rows(paths.home)
    memories = memory_summary(rows)
    facts = user_facts(messages, rows)
    hooks = transcript_hooks(sorted((paths.home / ".claude" / "projects").glob("*/*.jsonl")))
    every = [value for values in hooks["durations_ms"].values() for value in values]
    _, token = pick_token(args.agent, paths.controller / "tokens.jsonl")
    recall = recall_probes(paths, setup, facts, messages, token)
    hook_p95 = p95(every)
    timeouts = hooks["counts"].get("hook_cancelled", 0)
    gates = {"user_facts": facts["kept"] >= GATES["user_facts_kept"], "project_recall": recall["passed"],
             "one_vector_per_memory": memories["one_vector_per_memory"],
             "hook_p95": hook_p95 is not None and hook_p95 < GATES["hook_p95_ms"],
             "hook_timeouts": timeouts <= GATES["hook_timeouts"],
             "versions": all(row.get("claude_code_version") == CLAUDE_VERSION for row in journal),
             "drained": all(row.get("drain") and not row["drain"]["left"] for row in journal)}
    report = {"at": utc(), "run": args.run, "persona": args.persona, "agent": args.agent, "turns": len(journal),
              "gates": gates, "passed": all(gates.values()), "gate_thresholds": GATES, "memories": memories,
              "user_facts": facts, "recall": recall,
              "hooks": {**hooks, "p95_ms": hook_p95, "p95_ms_by_event": {k: p95(v) for k, v in
                                                                         hooks["durations_ms"].items()}},
              "drain_seconds": [row["drain"]["drain_seconds"] for row in journal if row.get("drain")],
              "sandbox_probes": [row["sandbox_probe"] for row in journal if row.get("sandbox_probe")],
              "rate_limit_headers": {"before": before, "after": after},
              "projection": projection(journal, before, after)}
    (paths.root / "smoke.json").write_text(json.dumps(report, indent=1))
    print(json.dumps({key: report[key] for key in ("gates", "passed", "projection")}, indent=1))
    print(f"smoke report: {paths.root / 'smoke.json'}")
    return 0 if report["passed"] else 1


def latest_results(paths: Paths) -> tuple[str | None, dict]:
    runs = sorted((paths.root / "tests").glob("hippo-*/results.json"), key=os.path.getmtime)
    return (runs[-1].parent.name, json.loads(runs[-1].read_text())) if runs else (None, {})


def ingest_record(paths: Paths) -> dict:
    """Turns, summed usage and the largest idle gap between turns: hippo's decay feels a long 429 pause."""
    journal = [json.loads(line) for line in (paths.controller / "journal.jsonl").read_text().splitlines()] \
        if (paths.controller / "journal.jsonl").is_file() else []
    usage = Counter()
    for row in journal:
        usage.update({key: value for key, value in (row.get("usage") or {}).items() if isinstance(value, (int, float))})
    ends = [datetime.fromisoformat(row["at"]).timestamp() for row in journal]
    gaps = [ends[i] - row["seconds"] - ends[i - 1] for i, row in enumerate(journal) if i]
    return {"turns": len(journal), "usage": dict(usage), "largest_gap_seconds": round(max(gaps), 1) if gaps else None}


def report_stage(args: Namespace) -> int:
    """Per-persona answers and passes from the newest run of each chain, with the audit lines and the rejudge."""
    personas, total, clean_total = {}, 0, 0
    for persona in ("morgan", "alex", "riley"):
        paths = Paths(args.run, persona)
        run_id, results = latest_results(paths)
        if run_id is None:
            continue
        rows = results.get("test_results", [])
        audit = []
        for audit_file in (paths.root / "tests").glob("hippo-*/hippo-audit.jsonl"):
            audit += [json.loads(line) for line in audit_file.read_text().splitlines()]
        last = {row["test_root"]: row for row in audit}
        passed = sum(bool(row.get("passed")) for row in rows)
        total += passed
        clean = [row for row in rows if (audit_row := last.get(Path(row.get("runtime_config_path") or "").parent.name))
                 and audit_row["hippo_reads"] == 0]
        clean_total += sum(bool(row.get("passed")) for row in clean)
        usage = Counter()
        for row in rows:
            usage.update({k: v for k, v in (row.get("token_usage") or {}).items() if isinstance(v, (int, float))})
        personas[persona] = {
            "run_id": run_id, "answers": len(rows), "passed": passed,
            "answers_without_hippo_reads": len(clean), "passed_without_hippo_reads": sum(
                bool(row.get("passed")) for row in clean),
            "test_usage": dict(usage), "ingest": ingest_record(paths),
            "driver_failures": sum(row.get("driver_ok") is not True for row in rows),
            "ungraded": sum(row.get("grade") is None for row in rows),
            "tests_reading_hippo_files": sum(row["hippo_reads"] > 0 for row in last.values()),
            "master_store_changed": sum(not row["master_unchanged"] for row in last.values()),
            "test_store_changed": sum(bool(row["test_store_changed"]) for row in last.values())}
    rejudged = {path.stem: json.loads(path.read_text())["summary"]
                for path in sorted((HOMES / "published").glob("rejudge-*.json"))}
    report = {"at": utc(), "run": args.run, "judge": JUDGE_MODEL, "personas": personas, "passed": total, "of": 600,
              "passed_without_hippo_reads": clean_total, "published_rows": PUBLISHED_ROWS,
              "rejudged_published": rejudged}
    (HOMES / args.run / "report.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))
    return 0


def published_results(arm: str, persona: str) -> Path | None:
    """The published results file, sha-checked; a local evidence copy first, else the official URL."""
    sources = json.loads((EVIDENCE / "official-small" / f"claude-{arm}-sources.json").read_text())[persona]
    if "results" not in sources:
        return None
    name, digest = f"{persona}-claude-{arm}-results.json.gz", sources["results"]["sha256"]
    target = HOMES / "published" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        local = EVIDENCE / name
        if local.is_file() and sha256_file(local) == digest:
            shutil.copyfile(local, target)
        else:
            with urllib.request.urlopen(sources["results"]["url"], timeout=300) as response:
                target.write_bytes(response.read())
    if sha256_file(target) != digest:
        target.unlink()
        raise SystemExit(f"{name} does not match its published sha256")
    return target


def rejudge_stage(args: Namespace) -> int:
    """Grades published Claude Code answers with this run's judge through the official grade(); judge calls only."""
    setup = load_setup()
    use_official(setup, args.persona, "fake")
    out = HOMES / "published" / f"rejudge-{args.arm}-{args.persona}.json"
    source = published_results(args.arm, args.persona)
    if source is None:
        summary = {"available": False, "reason": "the published sources list no results file with tool calls"}
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({"summary": summary}, indent=1))
        print(json.dumps(summary))
        return 0
    bundle = HOMES / "bundles" / args.persona
    os.environ["DOLPHINBENCH_TESTS_DIR"] = str(bundle / "tests" / args.persona)
    use_judge(args.judge_url, f"rejudge-{args.arm}-{args.persona}")
    from harness import run_simulation as runner
    rows = json.loads(gzip.decompress(source.read_bytes()))["test_results"]
    saved = json.loads(out.read_text()) if out.exists() else {"rows": {}}
    for row in sorted(rows, key=lambda r: r["test_id"])[:args.limit or None]:
        if row["test_id"] in saved["rows"]:
            continue
        spec = runner.load_test(str(row.get("source_id") or row["test_id"]))
        grade = runner.grade(spec, str(row.get("response") or ""), list(row.get("effective_tool_calls") or []),
                             str(row.get("query") or ""))
        saved["rows"][row["test_id"]] = {"published_passed": bool(row.get("passed")),
                                         "passed": bool(grade.get("passed")), "grade": grade}
        graded = saved["rows"].values()
        saved["summary"] = {"available": True, "arm": args.arm, "persona": args.persona, "judge": JUDGE_MODEL,
                            "source_sha256": sha256_file(source), "published_tests": len(rows),
                            "graded": len(graded), "passed": sum(r["passed"] for r in graded),
                            "published_passed": sum(r["published_passed"] for r in graded),
                            "agreement": sum(r["passed"] == r["published_passed"] for r in graded) / len(graded)}
        out.write_text(json.dumps(saved, indent=1))
    print(json.dumps(saved.get("summary"), indent=1))
    return 0
