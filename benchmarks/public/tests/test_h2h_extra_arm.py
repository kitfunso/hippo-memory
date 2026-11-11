"""mem0/h2h.py --arm hippo-emb (prereg Amendment 6 dated notes 5): the extra arm reads only its own gated retrieval, and
its score pairs it with each registered arm, re-made from the registered run's own call logs."""
from __future__ import annotations

import argparse
import hashlib
import sys

import pytest
from conftest import RUNNER

if not (RUNNER / "benchmarks" / "locomo" / "prompts.py").exists():
    pytest.skip("h2h needs Mem0's runner checkout", allow_module_level=True)

import h2h  # noqa: E402

EMB = "hippo-emb"


def gated_folder(root, arm: str, text: str = "{}"):
    f = root / f"predicted_locomo-{arm}"
    f.mkdir(parents=True)
    (f / "conv0_q1.json").write_text(text, encoding="utf-8")
    digest = hashlib.sha256((f / "conv0_q1.json").read_bytes()).hexdigest()
    (root / "MANIFEST-locomo.sha256").write_text(f"{digest}  predicted_locomo-{arm}/conv0_q1.json\n", encoding="utf-8")
    return f


def test_the_extra_arm_checks_its_own_manifest_and_not_mem0s_ingest(tmp_path, monkeypatch):
    emb_root = tmp_path / "emb"
    f = gated_folder(emb_root, EMB)
    monkeypatch.setattr(h2h, "RETRIEVAL_OF", {EMB: emb_root})
    monkeypatch.setattr(h2h, "RETRIEVAL", tmp_path / "registered-not-there")
    h2h.check_gate(tmp_path / "run-without-mem0-ingest", (EMB,))
    (f / "conv0_q1.json").write_text("{changed}", encoding="utf-8")
    with pytest.raises(SystemExit, match="differs from MANIFEST-locomo.sha256"):
        h2h.check_gate(tmp_path / "run-without-mem0-ingest", (EMB,))


def test_the_extra_arm_is_scored_minus_each_registered_arm_from_that_runs_logs(tmp_path, monkeypatch):
    qids, cutoffs = ["conv0_q1", "conv0_q2", "conv1_q1"], (200,)
    theirs = {"hippo365": 1.0, "bm25": 0.0, "mem0": 0.5}
    reg = {(arm, c, q): v for arm, v in theirs.items() for c in cutoffs for q in qids}
    seen = []
    monkeypatch.setattr(h2h, "check_gate", lambda run, arms: seen.append(("gate", run, arms)))
    monkeypatch.setattr(h2h, "all_answers", lambda a: seen.append(("answers", a.run, a.logs, a.arms)) or {})
    monkeypatch.setattr(h2h, "judge_key", lambda out, answers: {})
    monkeypatch.setattr(h2h, "f1_scores", lambda answers, data: reg)
    monkeypatch.setattr(h2h, "judge_scores", lambda a, judge, key, answers, data: (reg, {}))
    run, out = tmp_path / "run", tmp_path / "locomo-h2h"
    run.mkdir()
    (run / h2h.JUDGES["claude"][1]).write_text("", encoding="utf-8")
    a = argparse.Namespace(arm=EMB, arms=(EMB,), pairs_with=[run, out], qids=qids, cutoffs=cutoffs, run=tmp_path / "e",
                           out=tmp_path / "eo", logs=tmp_path / "e")
    mine = {(EMB, 200, q): 1.0 for q in qids}
    lines = h2h.pair_lines(a, [], qids[:2], {"F1": mine, "judge": mine, "judge2": mine})
    assert ("gate", run, h2h.ARMS) in seen and ("answers", run, run, h2h.ARMS) in seen
    for other, v in theirs.items():
        f1 = next(x for x in lines if x.startswith(f"top 200 {EMB} - {other} (") and x.split(")")[1].split(":")[0].strip() == "F1")
        assert f"({100 * v:.1f} in locomo-h2h)" in f1 and f"{100 * (1.0 - v):+.1f} pp" in f1 and "n=2 over 2 units" in f1
    assert not any("judge2" in x for x in lines)  # the registered run has no codex log here, so no judge2 pair


@pytest.mark.parametrize("extra", [["--arm", EMB], ["--pairs-with", "R", "O"], ["--arm", EMB, "--pairs-with", "RUN", "O"]])
def test_the_arm_needs_its_pair_and_its_own_folders(tmp_path, monkeypatch, extra):
    extra = [str(tmp_path / "run") if x == "RUN" else str(tmp_path / x) if x in ("R", "O") else x for x in extra]
    monkeypatch.setattr(sys, "argv", ["h2h.py", "answer", "--run", str(tmp_path / "run"), "--out", str(tmp_path / "out"),
                                      *extra])
    with pytest.raises(SystemExit):
        h2h.main()
