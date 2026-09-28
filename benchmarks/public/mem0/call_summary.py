"""Summary of the head-to-head's `claude -p` call logs (claude_llm.py's format): events, models, tokens, timing.

Usage: python call_summary.py LOG.jsonl [LOG.jsonl ...]
"""
from __future__ import annotations

import json
import math
import statistics
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

TOKENS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")


def counts(c: Counter) -> str:
    return ", ".join(f"{k} {v}" for k, v in sorted(c.items()))


def summary(path: Path) -> list[str]:
    recs = [json.loads(line) for line in path.read_bytes().split(b"\n") if line.strip()]  # LF alone: see h2h.read_jsonl
    ok = [r for r in recs if r["event"] == "ok"]
    usage = [r.get("usage") or {} for r in ok]
    tokens = {k: sum(u.get(k) or 0 for u in usage) for k in TOKENS}
    thinking = sum((u.get("output_tokens_details") or {}).get("thinking_tokens") or 0 for u in usage)
    wall = sorted(r["wall_ms"] / 1000 for r in ok)
    span = [datetime.fromtimestamp(r["ts"], timezone.utc).strftime("%Y-%m-%d %H:%M") for r in (recs[0], recs[-1])]
    return [
        f"{path.name}: {len(recs)} records, {span[0]} to {span[1]} UTC",
        f"  events: {counts(Counter(r['event'] for r in recs))}",
        f"  ok calls {len(ok)} over {len({r['tag'] for r in ok})} distinct tags, "
        f"{sum(r['attempt'] > 1 for r in ok)} needing more than one attempt, "
        f"usage-limit waits {sum(r.get('delay_s', 0) for r in recs if r['event'] == 'limit-wait')} s",
        f"  models: {counts(Counter(m for r in ok for m in r['models']))}; effort: {counts(Counter(r['effort'] for r in ok))}",
        "  tokens: " + ", ".join(f"{k} {v:,}" for k, v in tokens.items()) + f"; thinking {thinking:,}",
        f"  wall per ok call: median {statistics.median(wall):.1f} s, 90th percentile {wall[math.ceil(0.9 * len(wall)) - 1]:.1f} s",
        f"  API list-price equivalent reported by the CLI: ${sum(r.get('cost_usd_list') or 0 for r in ok):,.2f} "
        "(run on the Claude subscription, nothing billed)",
    ]


if __name__ == "__main__":
    print("\n".join(line for p in sys.argv[1:] for line in summary(Path(p))))
