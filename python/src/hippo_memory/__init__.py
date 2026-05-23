"""Async Python SDK for hippo-memory.

Wraps the HTTP API of the hippo-memory npm package. See `hippo_memory.Hippo`
for the main client class.

Quickstart::

    from hippo_memory import Hippo

    async with Hippo(base_url="http://127.0.0.1:3737") as client:
        mem = await client.remember(content="bug fix lesson")
        results = await client.recall(q="bug fix")
        ctx = await client.get_context(budget=1500)
"""

__version__ = "0.1.0"

# Models + client land in T3 and T4; for the scaffold commit (T2), expose
# only the version constant so `python -c "import hippo_memory"` works.
__all__ = ["__version__"]
