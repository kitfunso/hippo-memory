"""Example 1: basic remember + recall.

Prereq: `npm install -g hippo-memory@1.11.4` (or local repo build), then
`hippo serve` in another terminal.

Run::
    uv run python examples/01_basic_remember_recall.py
"""

import asyncio

from hippo_memory import Hippo


async def main() -> None:
    async with Hippo(base_url="http://127.0.0.1:3737") as client:
        # Persist 3 memories
        for content in [
            "bug fix: prevent shared tag array mutation in learnFromRepo",
            "performance: deduplicateLesson accepts pre-loaded entries",
            "security: tenant-filter response ids on /v1/outcome last-recall",
        ]:
            mem = await client.remember(content=content, tags=["example", "git-learned"])
            print(f"remembered {mem.id}: {content[:60]}")

        # Search them back
        results = await client.recall(q="bug fix", limit=5)
        print(f"\nrecall('bug fix'): {results.total} results, {results.tokens} tokens")
        for r in results.results:
            print(f"  {r.id}  score={r.score:.2f}  {(r.content or '')[:60]}")


if __name__ == "__main__":
    asyncio.run(main())
