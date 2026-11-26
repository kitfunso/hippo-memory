from __future__ import annotations

import atexit
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterator

import pytest

from hippo_cases import FAKE_JS, PLUGIN_ROOT, FakeHippo

_IMPORT_HOME = tempfile.mkdtemp(prefix="hippo-hermes-import-")
atexit.register(shutil.rmtree, _IMPORT_HOME, True)
os.environ["HERMES_HOME"] = _IMPORT_HOME
sys.path.insert(0, str(PLUGIN_ROOT))

import hippo

SCRUBBED_ENV = (
    "HIPPO_BIN", "HIPPO_TENANT", "XDG_DATA_HOME", "FAKE_HIPPO_LOG",
    "HERMES_SESSION_SOURCE", "HERMES_SINGLE_QUERY_SESSION", "HERMES_SESSION_SOURCE_EXPLICIT",
)
HOME_ENV = (
    ("HOME", "home"), ("USERPROFILE", "home"), ("APPDATA", "appdata"), ("LOCALAPPDATA", "localappdata"),
    ("HIPPO_HOME", "hippo-home"), ("HERMES_HOME", "hermes-home"),
)


@pytest.fixture(autouse=True)
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    dirs = {name: tmp_path / name for _, name in HOME_ENV}
    for folder in dirs.values():
        folder.mkdir(exist_ok=True)
    for key, name in HOME_ENV:
        monkeypatch.setenv(key, str(dirs[name]))
    for key in [*SCRUBBED_ENV, *(k for k in os.environ if k.startswith("FAKE_HIPPO_"))]:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("HIPPO_SKIP_AUTO_INTEGRATIONS", "1")
    monkeypatch.setattr(hippo, "LAUNCHER_FILE", tmp_path / "launcher.json")
    return SimpleNamespace(tmp=tmp_path, home=dirs["home"], hippo_home=dirs["hippo-home"],
                           hermes_home=dirs["hermes-home"])


@pytest.fixture
def fake(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> FakeHippo:
    script = tmp_path / "fake-hippo.js"
    script.write_text(FAKE_JS, encoding="utf-8")
    log = tmp_path / "fake-hippo.log"
    log.write_text("", encoding="utf-8")
    monkeypatch.setenv("HIPPO_BIN", str(script))
    monkeypatch.setenv("FAKE_HIPPO_LOG", str(log))
    return FakeHippo(script, log, monkeypatch)


@pytest.fixture
def started(monkeypatch: pytest.MonkeyPatch) -> list[SimpleNamespace]:
    seen: list[SimpleNamespace] = []
    real = subprocess.Popen

    def spy(*args: Any, **kwargs: Any) -> subprocess.Popen:
        proc = real(*args, **kwargs)
        seen.append(SimpleNamespace(proc=proc, argv=args[0], kwargs=kwargs))
        return proc

    monkeypatch.setattr(subprocess, "Popen", spy)
    return seen


@pytest.fixture
def start(env: SimpleNamespace) -> Iterator[Callable[..., hippo.HippoProvider]]:
    made: list[hippo.HippoProvider] = []

    def make(platform: str = "cli", session_id: str = "s1", **kwargs: Any) -> hippo.HippoProvider:
        provider = hippo.HippoProvider()
        provider.initialize(session_id, platform=platform, hermes_home=str(env.hermes_home), **kwargs)
        made.append(provider)
        return provider

    yield make
    for provider in made:
        provider.shutdown()
