"""Async Python SDK for hippo-memory.

Wraps the HTTP API of the hippo-memory npm package. See :class:`Hippo`
for the main client class.

Quickstart::

    from hippo_memory import Hippo

    async with Hippo(base_url="http://127.0.0.1:3737") as client:
        mem = await client.remember(content="bug fix lesson")
        results = await client.recall(q="bug fix")
        ctx = await client.get_context(budget=1500)
        await client.outcome(good=True)  # last-recall path

Requires a running ``hippo serve`` (npm package ``hippo-memory@>=1.11.4``).
"""

from hippo_memory.client import Hippo
from hippo_memory.models import (
    HealthInfo,
    MemoryEnvelope,
    RecallEntry,
    RecallResult,
    ContextEntry,
    ContextResult,
    OutcomeResult,
    SleepResult,
    DrillResult,
    ArchiveResult,
    SupersedeResult,
    PromoteResult,
    ForgetResult,
    AssembleResult,
    AuthCreated,
    AuthKey,
    AuthRevoked,
    AuditEvent,
    HippoError,
)

__version__ = "0.1.0"

__all__ = [
    "Hippo",
    "HealthInfo",
    "MemoryEnvelope",
    "RecallEntry",
    "RecallResult",
    "ContextEntry",
    "ContextResult",
    "OutcomeResult",
    "SleepResult",
    "DrillResult",
    "ArchiveResult",
    "SupersedeResult",
    "PromoteResult",
    "ForgetResult",
    "AssembleResult",
    "AuthCreated",
    "AuthKey",
    "AuthRevoked",
    "AuditEvent",
    "HippoError",
    "__version__",
]
