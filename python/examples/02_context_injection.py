import asyncio
import os

from hippo_memory import Hippo


def render(ctx) -> str:
    lines = [f"## Project Memory ({len(ctx.entries)} entries, {ctx.tokens} tokens)\n"]
    for item in ctx.entries:
        e = item.entry
        tag_str = f" [{', '.join(e.tags)}]" if e.tags else ""
        prefix = "[global] " if item.is_global else ""
        lines.append(f"- **{prefix}{e.content}**{tag_str} (score={item.score:.2f})")
    return "\n".join(lines)


async def main() -> None:
    async with Hippo(base_url="http://127.0.0.1:6789", api_key=os.environ["HIPPO_API_KEY"]) as client:
        for content in [
            "always use real DB for tests",
            "no em dashes in commit messages or release notes",
            "verify before claiming when challenged",
        ]:
            await client.remember(content=content, tags=["rule"])

        ctx = await client.get_context(budget=500)
        print(render(ctx))


if __name__ == "__main__":
    asyncio.run(main())
