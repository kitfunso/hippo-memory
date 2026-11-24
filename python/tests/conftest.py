from __future__ import annotations
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Iterator, NoReturn

import httpx
import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
HIPPO_BIN = REPO_ROOT / "bin" / "hippo.js"


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _unavailable(reason: str) -> NoReturn:
    if os.environ.get("HIPPO_REQUIRE_SERVE"):
        pytest.fail(reason)
    pytest.skip(reason)


def _wait_for_health(url: str, timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = httpx.get(f"{url}/health", timeout=1.0)
            if r.status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(0.1)
    return False


_ADMIN_KEYS: dict[str, str] = {}
_MEMBER_KEYS: dict[str, str] = {}


@pytest.fixture(scope="function")
def hippo_admin_key(hippo_server: str) -> str:
    return _ADMIN_KEYS[hippo_server]


@pytest.fixture(scope="function")
def hippo_member_key(hippo_server: str) -> str:
    return _MEMBER_KEYS[hippo_server]


@pytest.fixture(scope="function")
def hippo_server() -> Iterator[str]:
    if not HIPPO_BIN.exists():
        _unavailable(f"hippo binary not found at {HIPPO_BIN} (run `npm run build` in repo root)")

    home = tempfile.mkdtemp(prefix="hippo-py-test-")
    port = _pick_free_port()
    env = {
        **os.environ,
        "HIPPO_HOME": home,
        "HIPPO_TENANT": "default",
    }

    init = subprocess.run(
        ["node", str(HIPPO_BIN), "init", "--no-hooks"],
        env=env,
        cwd=home,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if init.returncode != 0:
        shutil.rmtree(home, ignore_errors=True)
        _unavailable(f"hippo init failed: {init.stderr or init.stdout}")

    mint = subprocess.run(
        ["node", str(HIPPO_BIN), "auth", "create", "--role", "admin", "--json"],
        env=env,
        cwd=home,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if mint.returncode != 0:
        shutil.rmtree(home, ignore_errors=True)
        _unavailable(f"hippo auth create failed: {mint.stderr or mint.stdout}")
    admin_key = json.loads(mint.stdout)["plaintext"]

    proc = subprocess.Popen(
        ["node", str(HIPPO_BIN), "serve", "--port", str(port)],
        env=env,
        cwd=home,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    url = f"http://127.0.0.1:{port}"
    ready = _wait_for_health(url)
    if not ready:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(home, ignore_errors=True)
        _unavailable(f"hippo serve did not respond on {url}/health within 20s; see TODOS.md python-v0.1 integration-test gap")

    _ADMIN_KEYS[url] = admin_key
    _MEMBER_KEYS[url] = (Path(home) / ".hippo" / "server.key").read_text().strip()
    try:
        yield url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(home, ignore_errors=True)
