"""Dated notes 15: a task's image is pulled before its trials, and no docker helper call can block the run."""
from __future__ import annotations

import json
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


def roomy(monkeypatch: pytest.MonkeyPatch, frees: list[float]) -> list[float]:
    """The image needs 20 GB; the drive shows each free size in turn, the last one for good."""
    monkeypatch.setattr(rt, "pull_gb", lambda image: 20 - rt.PULL_MARGIN_GB)
    monkeypatch.setattr(rt.shutil, "disk_usage", lambda p: type("U", (), {"free": (frees.pop(0) if len(frees) > 1 else frees[0]) * 1e9}))
    slept: list[float] = []
    monkeypatch.setattr(rt.time, "sleep", slept.append)
    return slept


def test_a_missing_image_is_pulled_with_its_own_long_timeout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = task(tmp_path, monkeypatch)
    assert roomy(monkeypatch, [50]) == []
    with pytest.raises(SystemExit, match="pull acme/big:1 failed"):
        rt.pull_image("big")
    assert calls[1] == (["docker", "pull", "acme/big:1"], {"timeout": rt.PULL_SEC})


def test_a_pull_waits_until_the_drive_has_room_for_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = task(tmp_path, monkeypatch)
    slept = roomy(monkeypatch, [9, 15, 25])
    with pytest.raises(SystemExit, match="pull acme/big:1 failed"):
        rt.pull_image("big")
    assert len(slept) == 2 and calls[1][0] == ["docker", "pull", "acme/big:1"]


def test_pull_size_is_three_times_the_registry_layers(monkeypatch: pytest.MonkeyPatch) -> None:
    man = {"Descriptor": {"platform": {"architecture": "amd64"}}, "OCIManifest": {"layers": [{"size": 3e9}, {"size": 1e9}]}}
    other = {"Descriptor": {"platform": {"architecture": "arm64"}}, "OCIManifest": {"layers": [{"size": 9e9}]}}
    for out in ([other, man], man):
        monkeypatch.setattr(rt, "sh", lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, json.dumps(out), ""))
        assert rt.pull_gb("acme/big:1") == 12.0


def test_a_finished_task_image_is_removed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    task(tmp_path, monkeypatch)
    calls: list[list[str]] = []
    monkeypatch.setattr(rt, "sh", lambda cmd, **kw: calls.append(cmd) or subprocess.CompletedProcess(cmd, 0, "", ""))
    rt.drop_image("big")
    assert calls[-1] == ["docker", "image", "rm", "acme/big:1"]


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
    monkeypatch.setattr(rt, "drop_image", lambda n: seen.append(f"drop {n}"))
    rt.run_all(tmp_path / "run", tmp_path, ["none"], None, [], "")
    assert seen == ["pull big", "trial none", "drop big"]


def test_a_helper_docker_call_has_a_timeout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = task(tmp_path, monkeypatch)
    rt.helper(tmp_path, tmp_path, "true")
    assert calls[0][1] == {"timeout": rt.HELPER_SEC}
