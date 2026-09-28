"""Load-bearing numbers for dolphinbench-feasibility.md, from the clone and the public Claude Code + Mem0 evidence.
Usage: C:/Users/skf_s/AppData/Local/Programs/Python/Python312/python.exe dolphin_stats.py [history|tests|results|evidence]"""
import gzip
import json
import statistics as st
import sys
from collections import Counter
from pathlib import Path

import tiktoken
import yaml

BENCH = Path(__file__).resolve().parents[4] / "hippo-bench"  # the clone and evidence stay outside this checkout
ROOT = BENCH / "dolphinbench"
PERSONAS = ("morgan", "alex", "riley")


def history() -> None:
    enc = tiktoken.get_encoding("o200k_base")
    for p in PERSONAS:
        sessions = yaml.safe_load((ROOT / f"registry/personas/{p}/life_sim.yaml").read_text(encoding="utf-8"))["sessions"]
        messages = [m for s in sessions for m in s["messages"]]
        toks = [len(enc.encode(m)) for m in messages]
        dates = sorted(s["narrative_date"] for s in sessions)
        print(f"history {p}: sessions={len(sessions)} messages={len(messages)} o200k_tokens={sum(toks)} "
              f"median={st.median(toks)} max={max(toks)} dates={dates[0]}..{dates[-1]}")


def tests() -> None:
    sys.path.insert(0, str(ROOT))
    from harness.dataset import load_test
    for p in PERSONAS:
        versions, llm_checks, judge_calls, anchors = Counter(), [], [], []
        for path in sorted((ROOT / "tests" / p).glob("[0-9][0-9][0-9].yaml")):
            test = load_test(path)
            anchors.append(str(test["narrative_anchor_date"]))
            cfg = test["grade"]["config"]
            semantic = cfg.get("semantic_judge_version", 1)
            versions[f"check_v{cfg.get('check_version', 1)}/judge_v{semantic}"] += 1
            llm = [a for a in cfg.get("assertions", []) if a["type"] == "field_llm_judge"]
            llm_checks.append(len(llm))
            judge_calls.append(len({a.get("action_id") for a in llm}) if semantic == 2 else len(llm))
        print(f"tests {p}: n={len(llm_checks)} versions={dict(versions)} llm_checks/test={st.mean(llm_checks):.2f} "
              f"max_judge_calls/test={st.mean(judge_calls):.2f} anchors={min(anchors)}..{max(anchors)}")


def results() -> None:
    base = ROOT / "results"
    for run in sorted(d for d in base.glob("*/*/*") if d.is_dir()):
        parts, passed, hours = [], 0, 0.0
        for p in PERSONAS:
            rows = json.loads((run / p / "tests.json").read_text(encoding="utf-8"))["tests"]
            n = sum(bool(r.get("passed")) for r in rows)
            h = sum(r["latency_seconds"] for r in rows if isinstance(r.get("latency_seconds"), (int, float))) / 3600
            parts.append(f"{p}={n}/{len(rows)} {h:.1f}h")
            passed, hours = passed + n, hours + h
        print(f"{run.relative_to(base).as_posix()}: pass={passed} latency_sum={hours:.1f}h | " + " ".join(parts))


def evidence() -> None:
    keys = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
    for p in PERSONAS:
        rows = json.load(gzip.open(BENCH / "evidence" / f"{p}-claude-mem0-results.json.gz"))["test_results"]
        inp = [sum(r["token_usage"].get(k, 0) for k in keys) for r in rows]
        out = [r["token_usage"].get("output_tokens", 0) for r in rows]
        calls = [r.get("session_tool_calls") or [] for r in rows]
        cached = sum(r["token_usage"].get("cache_read_input_tokens", 0) for r in rows) / sum(inp)
        judge = sum(len(d.get("judge_messages") or []) // 3 for r in rows for d in r["grade"]["details"])
        print(f"evidence {p}: n={len(rows)} input_side mean={st.mean(inp):.0f} total={sum(inp)} cache_read={cached:.0%} "
              f"output mean={st.mean(out):.0f} total={sum(out)} tool_calls/test={st.mean(map(len, calls)):.1f} "
              f"mem0_calls/test={st.mean(sum('mem0' in c['tool'] for c in cs) for cs in calls):.2f} "
              f"judge_calls={judge} agent_usd={sum(r['agent_cost_usd'] for r in rows):.2f} "
              f"basis={rows[0]['agent_cost_basis']!r}")


if __name__ == "__main__":
    for step in sys.argv[1:] or ("history", "tests", "results", "evidence"):
        globals()[step]()
