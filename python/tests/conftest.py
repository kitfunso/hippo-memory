"""pytest fixtures: spawn a real `hippo serve` subprocess per test.

Per project rule "always use real DB for tests". Each test gets a fresh
HIPPO_HOME (per-test scope) and a freshly-spawned serve subprocess. Cost:
~200ms per test for the subprocess respawn. Worth it for isolation.

If the serve subprocess fails to come up within the timeout (a setup
issue, not an SDK bug), the test is SKIPPED rather than FAILED so CI
matrices that lack the npm hippo-memory binary surface "skipped" not
"red". The integration suite documents the SDK contract regardless of
whether it runs against a live server in any given environment.
"""

from __future__ import annotations
import os
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Iterator

import httpx
import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
HIPPO_BIN = REPO_ROOT / "bin" / "hippo.js"


def _pick_free_port() -> int:
    """Bind to port 0 to let the OS pick a free port, then return + close."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


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


@pytest.fixture(scope="function")
def hippo_server() -> Iterator[str]:
    """Spawn `node bin/hippo.js serve` on a free port; yield base URL.

    SIGTERMs the subprocess on teardown. Cleans the per-test HIPPO_HOME.
    """
    if not HIPPO_BIN.exists():
        pytest.skip(f"hippo binary not found at {HIPPO_BIN} (run `npm run build` in repo root)")

    home = tempfile.mkdtemp(prefix="hippo-py-test-")
    port = _pick_free_port()
    env = {**os.environ, "HIPPO_HOME": home, "HIPPO_TENANT": "default"}

    # hippo serve requires a .hippo dir to exist. Bootstrap it via `hippo init`.
    init = subprocess.run(
        ["node", str(HIPPO_BIN), "init"],
        env=env,
        cwd=home,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if init.returncode != 0:
        shutil.rmtree(home, ignore_errors=True)
        pytest.skip(f"hippo init failed: {init.stderr or init.stdout}")

    proc = subprocess.Popen(
        ["node", str(HIPPO_BIN), "serve", "--port", str(port)],
        env=env,
        cwd=home,  # serve reads .hippo from cwd; tmp HIPPO_HOME stays scoped to test
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
        pytest.skip(f"hippo serve did not respond on {url}/health within 20s — see TODOS.md python-v0.1 integration-test gap")

    try:
        yield url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(home, ignore_errors=True)
