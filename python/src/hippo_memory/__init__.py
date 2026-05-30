"""Python SDK for hippo-memory.

Wraps the HTTP API of the hippo-memory npm package. Two client classes:

- :class:`Hippo` — async (default; recommended for FastAPI / asyncio code)
- :class:`HippoSync` — sync (v0.2.0+; for scripts / notebooks / threading)

Both are wire-compatible: same routes, same models, same errors.

Quickstart (async)::

    from hippo_memory import Hippo

    async with Hippo(base_url="http://127.0.0.1:3737") as client:
        mem = await client.remember(content="bug fix lesson")
        results = await client.recall(q="bug fix")
        ctx = await client.get_context(budget=1500)
        await client.outcome(good=True)  # last-recall path

Quickstart (sync, v0.2.0+)::

    from hippo_memory import HippoSync

    with HippoSync(base_url="http://127.0.0.1:3737") as client:
        mem = client.remember(content="bug fix lesson")
        results = client.recall(q="bug fix")

Requires a running ``hippo serve`` (npm package ``hippo-memory@>=1.11.4``).
"""

from hippo_memory.client import Hippo
from hippo_memory.sync_client import HippoSync
from hippo_memory.models import (
    HealthInfo,
    MemoryEnvelope,
    RecallEntry,
    RecallResult,
    RecallSuppressionSummary,
    PlanningFallacyHint,
    PlanningFallacyWatching,
    AnchoringHint,
    AvailabilityHint,
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
    Decision,
    Incident,
    Process,
    Policy,
    Skill,
    Prediction,
    PredictionBaserate,
    HippoError,
)

__version__ = "0.3.0"

__all__ = [
    "Hippo",
    "HippoSync",
    "HealthInfo",
    "MemoryEnvelope",
    "RecallEntry",
    "RecallResult",
    "RecallSuppressionSummary",
    "PlanningFallacyHint",
    "PlanningFallacyWatching",
    "AnchoringHint",
    "AvailabilityHint",
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
    "Decision",
    "Incident",
    "Process",
    "Policy",
    "Skill",
    "Prediction",
    "PredictionBaserate",
    "HippoError",
    "__version__",
]
