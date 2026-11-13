"""Replay fill_app_args on every v3pilot test: does the official exact match hold before and after?"""
import copy, json, sys
from pathlib import Path
sys.path[:0] = [sys.argv[1]]  # the adapter folder in the worktree
from dolphin_hippo import fill_app_args  # noqa: E402
from graders.mechanical import load_tool_calls  # noqa: E402
from harness.submission import SubmissionError, grading_calls  # noqa: E402

def ok(messages, calls):
    try:
        grading_calls({"messages": messages, "app_calls": calls}, "replay"); return True
    except SubmissionError:
        return False

for arm in ("hippo", "bm25"):
    run = Path.home() / f"dolphin/runs-v3/v3pilot-{arm}-morgan"
    rows = []
    for f in sorted((run / "tests/morgan").glob("*.json")):
        n = f.stem
        rec = json.loads(f.read_text())
        msgs = rec["row"]["messages"]
        calls = [{k: c[k] for k in ("tool", "args", "result") if k in c} for c in load_tool_calls(run / f"apps/morgan/{n}/calls.jsonl")]
        before = ok(msgs, calls) if calls else None
        filled = copy.deepcopy(msgs)
        if calls:
            fill_app_args(filled, calls)
        after = ok(filled, calls) if calls else None
        changed = sum(a != b for m0, m1 in zip(msgs, filled) for a, b in zip(m0.get("tool_calls", []), m1.get("tool_calls", [])))
        closed = bool(rec["attempts"][-1].get("closed"))
        rows.append((n, closed, len(calls), before, after, changed))
    print(arm, "test closed app_calls match_before match_after calls_filled")
    for r in rows:
        print(" ", *r)
