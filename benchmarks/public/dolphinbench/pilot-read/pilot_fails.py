"""Print the hand-read material for each attempt named on the command line (arm:test), or every fail."""
from __future__ import annotations

import json
import sys

rows = json.load(open(sys.argv[1]))
wanted = set(sys.argv[2:])
for r in rows:
    key = f"{r['arm']}:{r['test']}"
    if (wanted and key not in wanted) or (not wanted and r["passed"]):
        continue
    print("=" * 100)
    print(key, "PASS" if r["passed"] else "FAIL", r["injected"], "closed:", r["closed"])
    print("Q:", r["question"])
    for f, s in zip(r["facts"], r["fact_text"]):
        print(f"FACT {f}:", s[:700])
    print("NEED:", [(x["session"], x["hook_rank"]) for x in r["need"]], "memtool:", r["mem_tool_calls"],
          "ctx_read:", r["ctx_read"])
    for c in r["failed_checks"]:
        print(f"  FAILED check {c['check']} {c['type']} {c['tool']} {c['path']} value={c['value']}",
              "|", (c["criterion"] or "")[:500])
    for c in r["logged_calls"]:
        print("  APP", c["tool"], json.dumps(c["args"], ensure_ascii=False)[:1500])
    print("  FINAL:", r["final_text"][:400])
    for c in r["local_calls"]:
        print("  LOCAL", c["tool"], json.dumps(c["args"], ensure_ascii=False)[:300])
