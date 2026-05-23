"""Example 2: assemble a context bundle and render it as markdown.

Use case: your agent loop calls `get_context(...)` at the start of each
turn and injects the rendered output into the system prompt. The SDK
returns structured data; you render it however you like.

Run::
    uv run python examples/02_context_injection.py
"""

import asyncio

from hippo_memory import Hippo


def render(ctx) -> str:
    """Minimal markdown renderer mirroring the CLI's printContextMarkdown."""
    lines = [f"## Project Memory ({len(ctx.entries)} entries, {ctx.tokens} tokens)\n"]
    for item in ctx.entries:
        e = item.entry
        tag_str = f" [{', '.join(e.tags)}]" if e.tags else ""
        prefix = "[global] " if item.is_global else ""
        lines.append(f"- **{prefix}{e.content}**{tag_str} (score={item.score:.2f})")
    return "\n".join(lines)


async def main() -> None:
    async with Hippo(base_url="http://127.0.0.1:3737") as client:
        # Seed a handful so the bundle has something to assemble
        for content in [
            "always use real DB for tests",
            "no em dashes in commit messages or release notes",
            "verify before claiming when challenged",
        ]:
            await client.remember(content=content, tags=["rule"])

        ctx = await client.get_context(budget=500, framing=None) if False else await client.get_context(budget=500)
        print(render(ctx))


if __name__ == "__main__":
    asyncio.run(main())
