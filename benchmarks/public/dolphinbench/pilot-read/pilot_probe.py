"""Where each test's key fact text sits: hook ranks, the part that arrived, and tool results. Also date and local-write scans."""
from __future__ import annotations

import json
import re
from pathlib import Path

RUNS = Path.home() / "dolphin" / "runs-v3"
PROBES = {"001": r"[Bb]lue [Bb]ottle", "010": r"\$5,000|\$5k", "012": r"context note|one-paragraph|written context",
          "017": r"five minutes|5 minutes|5-minute|5 min|300 s", "019": r"\btabs\b", "006": r"\b236\b",
          "009": r"18\.9|4\.2k", "002": r"10:30", "020": r"business-grade", "013": r"open-mic|open mic",
          "007": r"data-room|data room", "014": r"[Rr]ecruiter [Oo]ps", "005": r"30 calendar|30-day|30 days",
          "003": r"graphql-quickstart", "011": r"\$5,000|5k", "015": r".", "018": r".", "016": r".", "004": r".", "008": r"."}
DATES = re.compile(r"November|Nov(ember)? 1[0-9]|2026-11|already passed|has passed|in the past|today is", re.I)


def preview(text: str) -> str:
    head = text[:2000]
    cut = head.rfind("\n")
    return head[:cut] if cut > 1000 else head


def tool_text(rec: dict) -> str:
    return " ".join(str(m.get("content")) for m in rec["row"]["messages"] if m["role"] == "tool")


def said(rec: dict) -> str:
    return " ".join(str(m.get("content") or "") for m in rec["row"]["messages"] if m["role"] == "assistant")


for arm in ("hippo", "bm25"):
    base = RUNS / f"v3pilot-{arm}-morgan"
    for n in range(1, 21):
        tid = f"{n:03d}"
        hook = json.loads((base / f"hooks/morgan/{tid}-0.json").read_text())
        rec = json.loads((base / f"tests/morgan/{tid}.json").read_text())
        ctx = hook["context"].strip()
        arrived = ctx if len(ctx) <= 10_000 else preview(ctx)
        probe = PROBES.get(tid)
        line = [arm, tid]
        if probe and probe != ".":
            ranks = [i + 1 for i, r in enumerate(hook["results"]) if re.search(probe, r["memory"])]
            line += [f"probe={probe!r}", f"ranks={ranks}", f"arrived={bool(re.search(probe, arrived))}",
                     f"tool_results={bool(re.search(probe, tool_text(rec)))}"]
        dates = sorted({m.group(0) for m in DATES.finditer(said(rec))})
        if dates:
            line.append(f"DATE_WORDS={dates}")
        for m in rec["row"]["messages"]:
            for c in m.get("tool_calls") or []:
                if c["name"] in ("Write", "Edit", "WebSearch", "WebFetch", "Bash", "Read", "Grep", "Glob"):
                    a = c["arguments"]
                    line.append(f"{c['name']}:{a.get('file_path') or a.get('query') or a.get('url') or a.get('command')}")
        print(" ".join(line))
