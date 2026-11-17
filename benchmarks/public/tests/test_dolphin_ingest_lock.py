"""One ingest per persona store: personas run in parallel, so a second writer must stop at the lock."""
import sys
from pathlib import Path

import pytest

pytest.importorskip("fcntl")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dolphinbench"))
import dolphin_official as do


def _paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, persona: str) -> do.Paths:
    monkeypatch.setattr(do, "HOMES", tmp_path)
    paths = do.Paths("run", persona)
    paths.controller.mkdir(parents=True)
    return paths


def test_second_ingest_on_one_persona_exits(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    paths = _paths(tmp_path, monkeypatch, "alex")
    held = do.hold_ingest_lock(paths)
    try:
        with pytest.raises(SystemExit, match="another ingest is writing"):
            do.hold_ingest_lock(paths)
    finally:
        held.close()
    do.hold_ingest_lock(paths).close()


def test_other_personas_ingest_at_the_same_time(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    alex = do.hold_ingest_lock(_paths(tmp_path, monkeypatch, "alex"))
    riley = do.hold_ingest_lock(_paths(tmp_path, monkeypatch, "riley"))
    alex.close()
    riley.close()
