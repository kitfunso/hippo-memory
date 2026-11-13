"""The DolphinBench hook keeps whole results, best first, under the char cap Claude Code passes through (dated notes 10)."""
from __future__ import annotations

import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from dolphinbench import dolphin_memory
from dolphinbench.dolphin_memory import MAX_CONTEXT_CHARS, fit, render


def results(*sizes: int) -> list[dict]:
    return [{"memory": f"m{i} " + "x" * (n - 3)} for i, n in enumerate(sizes)]


def test_fit_keeps_a_whole_prefix_under_the_cap() -> None:
    rs = results(*[1_000] * 20)
    kept = fit(rs)
    assert 0 < kept < 20
    assert len(render(rs[:kept])) <= MAX_CONTEXT_CHARS < len(render(rs[:kept + 1]))
    assert fit(results(100, 100)) == 2 and fit([]) == 0


def test_an_oversized_top_result_still_goes_in_alone() -> None:
    assert fit(results(MAX_CONTEXT_CHARS + 500, 50)) == 1


def test_the_hook_injects_only_the_kept_results(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rs = results(*[2_500] * 6)
    monkeypatch.setattr(dolphin_memory, "search", lambda *a: rs)
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"prompt": "[2025-01-01] what did I say?"})))
    out = io.StringIO()
    monkeypatch.setattr("sys.stdout", out)
    args = SimpleNamespace(url="http://x", user="u", limit=10, out=str(tmp_path / "hook.json"))
    assert dolphin_memory.hook(args) == 0
    record = json.loads((tmp_path / "hook.json").read_text(encoding="utf-8"))
    sent = json.loads(out.getvalue())["hookSpecificOutput"]["additionalContext"]
    assert record["kept"] == 3 and len(record["results"]) == 6 and record["query"] == "what did I say?"
    assert sent == record["context"] == render(rs[:3]) and len(sent) <= MAX_CONTEXT_CHARS
