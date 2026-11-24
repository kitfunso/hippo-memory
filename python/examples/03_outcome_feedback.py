import asyncio
import os

from hippo_memory import Hippo


async def main() -> None:
    async with Hippo(base_url="http://127.0.0.1:6789", api_key=os.environ["HIPPO_API_KEY"]) as client:
        mem = await client.remember(content="feedback-loop target memory")
        print(f"seeded {mem.id}")

        r1 = await client.outcome(good=True, ids=[mem.id])
        print(f"outcome(good=True, ids=[{mem.id}]) -> applied={r1.applied}")

        await client.get_context(budget=500)
        r2 = await client.outcome(good=False)
        print(f"outcome(good=False) last-recall -> applied={r2.applied}, ids={r2.ids}")

        events = await client.audit(op="outcome", limit=5)
        print(f"\naudit 'outcome' events:")
        for ev in events:
            print(f"  {ev.created_at}  actor={ev.actor}  target={ev.target_id}")


if __name__ == "__main__":
    asyncio.run(main())
