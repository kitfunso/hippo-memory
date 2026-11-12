"""qa/loaders/hotpotqa24.py score (dated notes 9): a paired run is scored with its own arms, so hippo-best pairs with
the hippo-emb run as well as with the registered one."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import RUNNER

if not (RUNNER / "benchmarks" / "locomo" / "prompts.py").exists():
    pytest.skip("h2h, which harness imports, needs Mem0's runner checkout", allow_module_level=True)

from qa.loaders import hotpotqa24


def test_each_paired_run_is_scored_with_the_arms_its_config_names(tmp_path, monkeypatch):
    ids, seen = ["q0", "q1"], []
    reg, emb, best = tmp_path / "reg", tmp_path / "emb", tmp_path / "best"
    for run, arms in ((reg, {"hippo365": "hippo", "bm25": "bm25"}), (emb, {"hippo-emb": "hippo"})):
        run.mkdir()
        (run / "config.json").write_text(json.dumps({"arms": arms}), encoding="utf-8")
    best.mkdir()

    def fake(out: Path, arm=None, pairs_with=(), arms=None):
        seen.append((out.name, arms))
        names = arms or {"hippo-best": "hippo"}
        a = type("A", (), {"arms": names})()
        return a, ids, ids, "note", {}, {(n, i): (1.0, 1.0) for n in names for i in ids}

    monkeypatch.setattr(hotpotqa24, "match_scores", fake)
    monkeypatch.setattr(hotpotqa24._harness(), "exhausted_lines", lambda *args: [])
    text = hotpotqa24.score(best, None, "hippo-best", (reg, emb))
    assert seen[1:] == [("reg", {"hippo365": "hippo", "bm25": "bm25"}), ("emb", {"hippo-emb": "hippo"})]
    assert "hippo-best - hippo-emb (100.0 in emb) F1" in text
