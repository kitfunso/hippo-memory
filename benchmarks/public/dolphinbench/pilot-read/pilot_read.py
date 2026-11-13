"""Read-only pass over the v3pilot run folders: one record per attempt, written as JSON to the path in argv[1]."""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import yaml

RUNS = Path.home() / "dolphin" / "runs-v3"
BENCH = Path(os.environ.get("DOLPHIN_BENCH_HOME", str(Path.home() / "hippo-bench"))) / "dolphinbench"
HEADER = "Memories from the user's past conversations that may be relevant to this request, most relevant first:\n"
TRIM_AT, PREVIEW, CAP = 10_000, 2_000, 9_000  # tnr=1e4 and eFe=2000 in Claude Code 2.1.259
MEMTOOL = "mcp__memory__search_memories"


def preview(text: str) -> str:
    """Claude Code's persisted-output preview: first 2000 chars, cut at the last newline if it is past 1000."""
    head = text[:PREVIEW]
    cut = head.rfind("\n")
    return head[:cut] if cut > PREVIEW * 0.5 else head


def render(results: list[dict]) -> str:
    return HEADER + "\n".join(f"{i}. {r['memory']}" for i, r in enumerate(results, 1)) if results else ""


def cap_keep(results: list[dict]) -> tuple[int, int]:
    kept = 0
    for k in range(1, len(results) + 1):
        if len(render(results[:k])) > CAP:
            break
        kept = k
    return kept, len(render(results[:kept]))


def session_index(arm_dir: Path) -> dict[str, str]:
    index = {}
    for path in (arm_dir / "ingestion" / "morgan").glob("*.json"):
        row = json.loads(path.read_text())["row"]
        index["user: " + row["messages"][0]["content"]] = row["session_id"]
    return index


def text_of(content) -> str:
    return content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)


def main() -> None:
    facts = {f["id"]: f for f in yaml.load((BENCH / "registry/personas/morgan/facts.yaml").read_text(),
                                            Loader=yaml.CSafeLoader)["facts"]}
    out = []
    for arm in ("hippo", "bm25"):
        arm_dir = RUNS / f"v3pilot-{arm}-morgan"
        index = session_index(arm_dir)
        by_session = {v: k for k, v in index.items()}
        for n in range(1, 21):
            tid = f"{n:03d}"
            spec = yaml.load((BENCH / f"tests/morgan/{tid}.yaml").read_text(), Loader=yaml.CSafeLoader)
            test = json.loads((arm_dir / f"tests/morgan/{tid}.json").read_text())
            grade = json.loads((arm_dir / f"grades/morgan/{tid}.json").read_text())
            hook = json.loads((arm_dir / f"hooks/morgan/{tid}-0.json").read_text())
            att = test["attempts"][-1]
            ctx = (hook.get("context") or "").strip()
            arrived = ctx if len(ctx) <= TRIM_AT else preview(ctx)
            results = hook.get("results", [])
            ranks = [index.get(r["memory"]) for r in results]
            need_facts = spec.get("load_bearing_facts") or []
            need = {s for f in need_facts for s in facts[f]["source_session_ids"]}
            related = {s for f in need_facts for s in facts[f].get("related_history_session_ids", [])}
            msgs = test["row"]["messages"]
            calls = {c["id"]: c for m in msgs if m["role"] == "assistant" for c in m.get("tool_calls") or []}
            outputs = {m.get("tool_call_id"): text_of(m.get("content")) for m in msgs if m["role"] == "tool"}
            mem_calls = [c for c in calls.values() if c["name"] == MEMTOOL]
            ctx_reads = [c for c in calls.values() if c["name"] == "Read"
                         and "additionalContext" in str(c["arguments"].get("file_path", ""))]
            # Read output prefixes each line with its number and a tab.
            read_text = "\n".join(re.sub(r"^\s*\d+\t", "", line) for c in ctx_reads
                                  for line in outputs.get(c["id"], "").splitlines())
            mem_text = "\n".join(outputs.get(c["id"], "") for c in mem_calls)
            local = [{"tool": c["name"], "args": c["arguments"]} for c in calls.values()
                     if c["name"] in ("Bash", "Read", "Grep", "Glob")]

            def where(sid: str) -> dict:
                body = by_session.get(sid, "")
                probe = body[6:400]
                rank = ranks.index(sid) + 1 if sid in ranks else None
                kept, _ = cap_keep(results)
                return {"session": sid, "hook_rank": rank, "whole_in_arrived": bool(body) and body in arrived,
                        "start_in_arrived": bool(probe) and probe in arrived,
                        "in_cap": rank is not None and rank <= kept,
                        "in_ctx_read": bool(probe) and probe in read_text,
                        "in_memory_tool": bool(probe) and probe in mem_text, "chars": len(body)}

            checks = grade.get("checks", [])
            asserts = spec["grade"]["config"].get("assertions", [])
            failed = []
            for c in checks:
                if not c.get("passed"):
                    a = asserts[c["check"]] if c["check"] < len(asserts) else {}
                    verdict = ""
                    for m in c.get("messages") or []:
                        if m.get("role") == "assistant":
                            verdict = text_of(m.get("content"))[:400]
                    failed.append({"check": c["check"], "type": a.get("type"), "tool": a.get("tool"),
                                   "path": a.get("path"), "value": a.get("value"),
                                   "criterion": a.get("criterion"), "judge": verdict,
                                   "keys": sorted(k for k in c if k != "messages")})
            kept, kept_chars = cap_keep(results)
            out.append({
                "arm": arm, "test": tid, "question": msgs[0]["content"], "query": hook.get("query"),
                "passed": bool(checks) and all(c.get("passed") for c in checks), "n_checks": len(checks),
                "failed_checks": failed, "outcome": att.get("outcome"), "injected": att.get("injected"),
                "attempts": len(test["attempts"]), "closed": att.get("closed"), "error": att.get("error"),
                "hook_error": att.get("hook_error"), "message_models": att.get("message_models"),
                "effort": att.get("effort"), "model_usage": sorted(att.get("model_usage") or {}),
                "cost": att.get("total_cost_usd"), "duration_ms": att.get("duration_ms"), "wall_ms": att.get("wall_ms"),
                "turns": att.get("num_turns"), "ctx_chars": len(ctx), "arrived_chars": len(arrived),
                "n_results": len(results), "result_chars": [len(r["memory"]) for r in results],
                "cap_kept": kept, "cap_chars": kept_chars, "unmapped_results": ranks.count(None),
                "ranks": ranks, "need": [where(s) for s in sorted(need)],
                "related": [where(s) for s in sorted(related)], "facts": need_facts,
                "fact_text": [facts[f]["statement"] for f in need_facts],
                "mem_tool_calls": [c["arguments"] for c in mem_calls], "ctx_read": len(ctx_reads),
                "ctx_read_chars": len(read_text), "tool_calls": att.get("tool_calls"), "local_calls": local,
                "app_calls": test["row"].get("app_calls"), "expected_tools": spec.get("expected_tool_calls"),
                "logged_calls": [{"tool": c["tool"], "args": c["args"]} for c in map(json.loads, (
                    arm_dir / f"apps/morgan/{tid}/calls.jsonl").read_text().splitlines()) if c],
                "final_text": text_of(msgs[-1].get("content"))[:600],
            })
    Path(sys.argv[1]).write_text(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
