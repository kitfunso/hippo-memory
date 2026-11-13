"""Memory surface for the DolphinBench hippo arms, identical for both arms: a UserPromptSubmit hook that
injects the top matches for the prompt, and a stdio MCP server with one search tool. Neither can write.
Usage: dolphin_memory.py hook|mcp --url http://127.0.0.1:PORT --user USER_ID [--limit N] [--out FILE]"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

DATE_PREFIX = re.compile(r"^\[[^\]]*\]\s*")
HEADER = "Memories from the user's past conversations that may be relevant to this request, most relevant first:\n"
MAX_LIMIT = 50
MAX_CONTEXT_CHARS = 9_000  # Claude Code cut every pilot context past about 10,000 chars (v3pilot, dated notes 10)


def search(url: str, user: str, query: str, limit: int) -> list[dict]:
    body = json.dumps({"query": query, "user_id": user, "limit": limit}).encode()
    request = urllib.request.Request(f"{url}/search", body, {"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)["results"]


def render(results: list[dict]) -> str:
    if not results:
        return "No stored memories matched."
    return HEADER + "\n".join(f"{i}. {r['memory']}" for i, r in enumerate(results, 1))


def fit(results: list[dict], limit: int = MAX_CONTEXT_CHARS) -> int:
    """How many results, best first and each whole, the hook injects; the top one stays even if it alone is over."""
    kept = min(1, len(results))
    while kept < len(results) and len(render(results[:kept + 1])) <= limit:
        kept += 1
    return kept


def hook(args: argparse.Namespace) -> int:
    started = time.monotonic()
    prompt = str(json.load(sys.stdin).get("prompt", ""))
    record: dict = {"query": DATE_PREFIX.sub("", prompt, count=1)}
    try:
        record["results"] = search(args.url, args.user, record["query"], args.limit)
        record["kept"] = fit(record["results"])
        record["context"] = render(record["results"][:record["kept"]])
    except (OSError, ValueError, KeyError) as exc:
        record["error"] = repr(exc)
    record["seconds"] = round(time.monotonic() - started, 3)
    Path(args.out).write_text(json.dumps(record), encoding="utf-8")
    if "error" in record:
        # Exit 2 blocks the prompt, so no model call is spent on a turn without its memory.
        print(f"memory hook failed: {record['error']}", file=sys.stderr)
        return 2
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                             "additionalContext": record["context"]}}))
    return 0


def serve(args: argparse.Namespace) -> None:
    from mcp.server.fastmcp import FastMCP

    server = FastMCP("memory")

    @server.tool()
    def search_memories(query: str, limit: int = 10) -> str:
        """Search the user's stored memories of past conversations. Returns the best matches, most relevant first."""
        return render(search(args.url, args.user, query, max(1, min(int(limit), MAX_LIMIT))))

    server.run()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("hook", "mcp"))
    parser.add_argument("--url", required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--out", help="hook only: where to save the query, results and injected text")
    args = parser.parse_args()
    if args.mode == "hook":
        return hook(args)
    serve(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
