"""Example 3: outcome feedback loop.

After your agent retrieves memories and uses them, mark the recall as
good or bad. Positive outcomes boost strength; negative outcomes decay it.

The last-recall path uses last_retrieval_ids (populated by `get_context`,
NOT by `recall`; the CLI's cmdRecall populates it but the api/HTTP path
does not — tracked in TODOS.md as a CLI/HTTP parity gap).

Run::
    uv run python examples/03_outcome_feedback.py
"""

import asyncio

from hippo_memory import Hippo


async def main() -> None:
    async with Hippo(base_url="http://127.0.0.1:3737") as client:
        # Seed a memory
        mem = await client.remember(content="feedback-loop target memory")
        print(f"seeded {mem.id}")

        # Specific-id path: explicitly outcome a single id
        r1 = await client.outcome(good=True, ids=[mem.id])
        print(f"outcome(good=True, ids=[{mem.id}]) -> applied={r1.applied}")

        # Last-recall path: assemble context first to populate last_retrieval_ids,
        # then outcome with no ids
        await client.get_context(budget=500)
        r2 = await client.outcome(good=False)  # no ids -> last-recall path
        print(f"outcome(good=False) last-recall -> applied={r2.applied}, ids={r2.ids}")

        # Inspect the audit trail (last 5 'outcome' events)
        events = await client.audit(op="outcome", limit=5)
        print(f"\naudit 'outcome' events:")
        for ev in events:
            print(f"  {ev.created_at}  actor={ev.actor}  target={ev.target_id}")


if __name__ == "__main__":
    asyncio.run(main())
