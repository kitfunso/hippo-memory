from __future__ import annotations

import sqlite3
import subprocess
from contextlib import closing
from pathlib import Path

import pytest
from session_rules.turns import SUMMARY_PREFIX, _MERGED_PRIOR_CONTEXT_HEADER, _MERGED_SUMMARY_DELIMITER

from hippo_cases import REAL_HIPPO_BIN, session

INIT_FLAGS = ("--no-hooks", "--no-schedule", "--no-learn", "--no-embeddings")
RULE = "Always run the linter before you push to the shared branch."
RULE_WORDS = "run the linter before you push"


def hippo_cli(*args: str, cwd: Path) -> None:
    done = subprocess.run(["node", REAL_HIPPO_BIN, *args], cwd=str(cwd), capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=120)
    assert done.returncode == 0, done.stderr or done.stdout


def rows(store: Path) -> list[tuple[str, str]]:
    with closing(sqlite3.connect(store / "hippo.db")) as db:
        return db.execute("select content, source_session_id from memories").fetchall()


@pytest.fixture
def project(env, tmp_path, monkeypatch) -> Path:
    assert Path(REAL_HIPPO_BIN).is_file(), f"{REAL_HIPPO_BIN} is missing: run npm run build first"
    monkeypatch.setenv("HIPPO_BIN", REAL_HIPPO_BIN)
    hippo_cli("init", "--global", *INIT_FLAGS, cwd=env.home)
    folder = tmp_path / "project"
    folder.mkdir()
    hippo_cli("init", *INIT_FLAGS, cwd=folder)
    monkeypatch.chdir(folder)
    return folder


def test_capture_lands_in_the_global_store_only(project, env, start):
    provider = start(session_id="e2e-1")
    provider.on_session_end(session(RULE, "I will run the linter first."))
    provider.shutdown()
    found = rows(env.hippo_home)
    assert any(RULE_WORDS in content and sid == "e2e-1" for content, sid in found), found
    assert rows(project / ".hippo") == []


def test_one_session_captured_twice_keeps_each_text_once(project, env, start):
    provider = start(session_id="s1")
    provider.on_session_end(session(RULE))
    provider.on_session_switch("s1", parent_session_id="s1", reset=False, reason="compression")
    carrier = (f"{_MERGED_PRIOR_CONTEXT_HEADER}\n{RULE}\n\n{_MERGED_SUMMARY_DELIMITER}\n\n"
               f"{SUMMARY_PREFIX}\nsummary body words")
    provider.on_session_end([{"role": "user", "content": carrier}, {"role": "assistant", "content": "On it."}])
    provider.shutdown()
    found = rows(env.hippo_home)
    assert sum(RULE_WORDS in content for content, _ in found) == 1, found
    assert not any("summary body words" in content for content, _ in found)


def test_relative_hippo_home_writes_to_cwd_store_not_home(env, tmp_path, start, monkeypatch):
    assert Path(REAL_HIPPO_BIN).is_file(), f"{REAL_HIPPO_BIN} is missing: run npm run build first"
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)
    monkeypatch.setenv("HIPPO_BIN", REAL_HIPPO_BIN)
    monkeypatch.setenv("HIPPO_HOME", "./rel-store")
    hippo_cli("init", "--global", *INIT_FLAGS, cwd=work)
    provider = start(session_id="rel-1")
    provider.on_session_end(session(RULE, "I will run the linter first."))
    provider.shutdown()
    found = rows(work / "rel-store")
    assert any(RULE_WORDS in content and sid == "rel-1" for content, sid in found), found
    assert not (env.home / "rel-store").exists()
