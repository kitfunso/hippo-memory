"""Dated notes 14: one process at a time asks into a run folder, in both the qa harness and the runner."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

import harness
from qa.ledger import one_writer


def runner_main():
    pytest.importorskip("aiolimiter", reason="the runner modules import only with the runner venv's packages")
    import answer_judge
    return answer_judge.main


def dead_pid() -> int:
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


def test_a_second_writer_on_a_held_folder_stops_and_the_lock_goes_at_exit(tmp_path: Path) -> None:
    with one_writer(tmp_path):
        with pytest.raises(SystemExit, match="is in use by pid"):
            with one_writer(tmp_path):
                pass
    assert not (tmp_path / ".writer.lock").exists()


def test_a_lock_left_by_a_dead_process_is_taken_over(tmp_path: Path) -> None:
    (tmp_path / ".writer.lock").write_text(str(dead_pid()), encoding="ascii")
    with one_writer(tmp_path):
        assert (tmp_path / ".writer.lock").exists()


@pytest.mark.parametrize("main, argv", [
    (lambda: harness.main, ["harness.py", "answer", "--bench", "prefeval"]),
    (lambda: harness.main, ["harness.py", "judge", "--bench", "prefeval"]),
    (runner_main, ["answer_judge.py", "run", "--bench", "longmemeval-m", "--pred", "hippo-emb=x"]),
])
def test_answer_judge_and_run_stages_take_the_folder_first(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                            main, argv) -> None:
    entry = main()
    monkeypatch.setattr(sys, "argv", [*argv, "--out", str(tmp_path)])
    with one_writer(tmp_path), pytest.raises(SystemExit, match="is in use by pid"):
        entry()
