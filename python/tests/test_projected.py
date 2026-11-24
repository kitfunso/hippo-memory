from __future__ import annotations

from hippo_memory.models import ContextEntry, MemoryEnvelope


def test_projected_returns_cli_shape():
    entry = MemoryEnvelope(
        id="mem_test_001",
        content="lesson about cache refresh",
        strength=0.85,
        tags=["lesson", "cache"],
        confidence="verified",
    )
    ctx_entry = ContextEntry(
        entry=entry,
        score=0.92,
        tokens=42,
        is_global=False,
        is_fresh_tail=False,
    )

    projected = ctx_entry.projected()
    assert projected == {
        "id": "mem_test_001",
        "score": 0.92,
        "strength": 0.85,
        "tags": ["lesson", "cache"],
        "confidence": "verified",
        "content": "lesson about cache refresh",
        "global": False,
    }


def test_projected_global_true_when_is_global_set():
    entry = MemoryEnvelope(id="mem_global_001", content="cross-project lesson")
    ctx_entry = ContextEntry(entry=entry, score=0.5, tokens=10, is_global=True)
    assert ctx_entry.projected()["global"] is True


def test_projected_global_false_when_is_global_none():
    entry = MemoryEnvelope(id="mem_local_001", content="local-only")
    ctx_entry = ContextEntry(entry=entry, score=0.5, tokens=10)
    assert ctx_entry.projected()["global"] is False


def test_projected_optional_fields_pass_through_as_none():
    entry = MemoryEnvelope(id="mem_partial_001", content="bare entry")
    ctx_entry = ContextEntry(entry=entry, score=0.1, tokens=5)
    projected = ctx_entry.projected()
    assert projected["strength"] is None
    assert projected["confidence"] is None
    assert projected["tags"] == []


def test_projected_carries_lead_in_only_when_set():
    led = MemoryEnvelope.model_validate({"id": "mem_led", "content": "Three times a week", "leadIn": "user: How often?"})
    projected = ContextEntry(entry=led, score=0.5, tokens=5).projected()
    assert projected["lead_in"] == "user: How often?"
    assert list(projected).index("lead_in") == list(projected).index("content") + 1
    plain = MemoryEnvelope(id="mem_plain", content="no lead-in")
    assert "lead_in" not in ContextEntry(entry=plain, score=0.5, tokens=5).projected()
