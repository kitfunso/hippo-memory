"""Amendment 7 dated notes 4: a trial whose grader timed out has no score, so it is infrastructure and runs again."""
from __future__ import annotations

import json
from pathlib import Path

from terminalbench import run_tbench as rt


def job(tmp_path: Path, exc: str | None, verifier: dict | None) -> Path:
    t = tmp_path / "job" / "task__x"
    (t / "agent").mkdir(parents=True)
    (t / "result.json").write_text(json.dumps({
        "agent_execution": {"started_at": "2026-11-20T08:49:09", "finished_at": "2026-11-20T08:53:14"},
        "verifier_result": verifier,
        "exception_info": {"exception_type": exc, "exception_message": "timed out"} if exc else None}), encoding="utf-8")
    (t / "agent" / "claude-code.txt").write_text(json.dumps({"type": "result", "num_turns": 21, "result": "done"}) + "\n",
                                                 encoding="utf-8")
    return tmp_path / "job"


def test_a_grader_timeout_is_infrastructure_and_a_graded_fail_is_not(tmp_path: Path) -> None:
    lost = rt.trial_outcome(job(tmp_path / "a", "VerifierTimeoutError", None))
    assert lost["infra"] and lost["why"] == "timed out"
    graded = rt.trial_outcome(job(tmp_path / "b", None, {"rewards": {"reward": 0.0}}))
    assert graded["infra"] is False and graded["reward"] == 0.0


def test_a_grader_timeout_logged_before_the_rule_is_not_a_finished_trial(tmp_path: Path) -> None:
    rec = {"task": "t", "arm": "hippo", "reward": 0.0, "infra": False, "exception": "VerifierTimeoutError"}
    lines = [rec, {**rec, "task": "u", "exception": None}]
    (tmp_path / "progress.jsonl").write_text("".join(json.dumps(r) + "\n" for r in lines), encoding="utf-8")
    assert list(rt.done(tmp_path)) == [("u", "hippo")]
