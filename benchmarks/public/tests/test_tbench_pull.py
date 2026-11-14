"""Dated notes 15: a task's image is pulled before its trials, and no docker helper call can block the run."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from terminalbench import run_tbench as rt


def task(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> list[tuple[list[str], dict]]:
    (tmp_path / "big").mkdir()
    (tmp_path / "big" / "task.toml").write_text('[environment]\ndocker_image = "acme/big:1"\n', encoding="utf-8")
    monkeypatch.setattr(rt, "TASKS", tmp_path)
    calls: list[tuple[list[str], dict]] = []
    monkeypatch.setattr(rt, "sh", lambda cmd, **kw: calls.append((cmd, kw)) or subprocess.CompletedProcess(cmd, 1, "", "no"))
    return calls


def test_a_missing_image_is_pulled_with_its_own_long_timeout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = task(tmp_path, monkeypatch)
    with pytest.raises(SystemExit, match="pull acme/big:1 failed"):
        rt.pull_image("big")
    assert calls[1] == (["docker", "pull", "acme/big:1"], {"timeout": rt.PULL_SEC})


def test_a_present_image_is_not_pulled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    task(tmp_path, monkeypatch)
    calls: list[list[str]] = []
    monkeypatch.setattr(rt, "sh", lambda cmd, **kw: calls.append(cmd) or subprocess.CompletedProcess(cmd, 0, "", ""))
    rt.pull_image("big")
    assert calls == [["docker", "image", "inspect", "acme/big:1"]]


def test_the_run_pulls_a_task_image_before_its_trials(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []
    monkeypatch.setattr(rt, "task_order", lambda: ["big"])
    monkeypatch.setattr(rt, "task_digest", lambda n: "x")
    monkeypatch.setattr(rt, "agent_env", lambda: {})
    monkeypatch.setattr(rt, "pull_image", lambda n: seen.append(f"pull {n}"))
    monkeypatch.setattr(rt, "run_one", lambda run, bdir, arm, idx, n, env: seen.append(f"trial {arm}"))
    rt.run_all(tmp_path / "run", tmp_path, ["none"], None, [], "")
    assert seen == ["pull big", "trial none"]


def test_a_helper_docker_call_has_a_timeout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = task(tmp_path, monkeypatch)
    rt.helper(tmp_path, tmp_path, "true")
    assert calls[0][1] == {"timeout": rt.HELPER_SEC}
