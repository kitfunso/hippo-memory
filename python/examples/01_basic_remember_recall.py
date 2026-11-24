import asyncio
import os

from hippo_memory import Hippo


async def main() -> None:
    async with Hippo(base_url="http://127.0.0.1:6789", api_key=os.environ["HIPPO_API_KEY"]) as client:
        for content in [
            "bug fix: prevent shared tag array mutation in learnFromRepo",
            "performance: deduplicateLesson accepts pre-loaded entries",
            "security: tenant-filter response ids on /v1/outcome last-recall",
        ]:
            mem = await client.remember(content=content, tags=["example", "git-learned"])
            print(f"remembered {mem.id}: {content[:60]}")

        results = await client.recall(q="bug fix", limit=5)
        print(f"\nrecall('bug fix'): {results.total} results, {results.tokens} tokens")
        for r in results.results:
            print(f"  {r.id}  score={r.score:.2f}  {(r.content or '')[:60]}")


if __name__ == "__main__":
    asyncio.run(main())
