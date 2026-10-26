"""The key a client sends with no `api_key`: HIPPO_API_KEY, else a loopback server's key file, as the CLI does."""

from __future__ import annotations

from pathlib import Path

import pytest

from hippo_memory._auth import resolve_api_key

LOCAL = "http://127.0.0.1:3737"


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A working folder and a global store of the test's own, with no key in the environment."""
    work = tmp_path / "work" / "sub"
    work.mkdir(parents=True)
    monkeypatch.chdir(work)
    monkeypatch.setenv("HIPPO_HOME", str(tmp_path / "global"))
    monkeypatch.delenv("HIPPO_API_KEY", raising=False)
    return tmp_path


def write_key(folder: Path, key: str) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "server.key").write_text(f"{key}\n", encoding="utf-8")


def test_an_explicit_key_wins(isolated: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HIPPO_API_KEY", "hk_env")
    write_key(isolated / "work" / ".hippo", "hl_project")
    assert resolve_api_key(LOCAL, "hk_given") == "hk_given"


def test_hippo_api_key_comes_before_any_key_file(isolated: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HIPPO_API_KEY", "  hk_env  ")
    write_key(isolated / "work" / ".hippo", "hl_project")
    assert resolve_api_key(LOCAL, None) == "hk_env"


def test_the_nearest_project_store_comes_before_the_global_one(isolated: Path) -> None:
    write_key(isolated / "work" / ".hippo", "hl_project")
    write_key(isolated / "global", "hl_global")
    assert resolve_api_key("http://localhost:3737", None) == "hl_project"


def test_the_global_store_answers_when_no_project_has_a_key(isolated: Path) -> None:
    write_key(isolated / "global", "hl_global")
    assert resolve_api_key("http://[::1]:3737", None) == "hl_global"


def test_a_key_file_is_never_sent_to_another_machine(isolated: Path) -> None:
    write_key(isolated / "work" / ".hippo", "hl_project")
    assert resolve_api_key("https://hippo.example.com", None) is None


def test_no_key_anywhere_sends_none(isolated: Path) -> None:
    assert resolve_api_key(LOCAL, None) is None
