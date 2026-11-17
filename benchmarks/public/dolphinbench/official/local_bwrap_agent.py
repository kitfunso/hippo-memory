"""One root bubblewrap sandbox per test on this host, with ModalAgentContainer's constructor and run() contract.
dolphin_official.py setup copies this file into reference/execution/ of the patched official tree."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from reference.execution.agent_container import AppBridge

BIN = Path("/opt/dolphin-official/bin")
sys.path.insert(0, str(BIN))
import dolphin_sandbox  # noqa: E402 - lives in the root-owned runner bin, not the official tree


def store_hashes(home: Path) -> dict[str, str]:
    return {str(path.relative_to(home)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(home.glob("**/.hippo/hippo.db")) if path.is_file()}


class LocalBwrapAgentContainer:
    """The payload is bound at /payload and an empty folder at the agent home, which hides the master store; the
    app server runs on the host behind the official AppBridge socket, as the Modal tunnel's far end does."""

    def __init__(self, image, payload, command, environment, app_command, app_environment, *,
                 endpoints=None, ports=None, reuse_key=None, **_):
        if endpoints or ports:
            raise ValueError("the local sandbox forwards no memory service; hippo's store lives in the agent home")
        self.payload, self.command = Path(payload), list(command)
        self.environment = dict(environment)
        self.app_command, self.app_environment = app_command, app_environment
        self.output_valid = False

    def run(self, output: Path, timeout=None):
        request = json.loads((self.payload / "request.json").read_text())
        shutil.copyfile(BIN / "dolphin_bridge_client.py", self.payload / "agent_bridge_client.py")
        home = self.payload.parent / "home"
        home.mkdir()
        bridge = AppBridge(self.payload / "apps.sock", self.app_command, self.app_environment)
        thread = threading.Thread(target=bridge.serve_forever, daemon=True)
        thread.start()
        binds = ["--bind", str(self.payload), "/payload", "--bind", str(home), request["home"]]
        args = [*dolphin_sandbox.bwrap(binds, "/payload/work", root=True),
                "python", "/payload/agent_bridge_client.py", *self.command]
        env = {"PATH": os.environ["PATH"], "LANG": "C.UTF-8", **self.environment}
        started = time.monotonic()
        try:
            return subprocess.run(args, env=env, capture_output=True, text=True, timeout=timeout, check=False)
        finally:
            try:
                shutil.copytree(self.payload / "output", output, dirs_exist_ok=True)
                (output / "sandbox.json").write_text(json.dumps({
                    "argv": args, "env_keys": sorted(env), "seconds": round(time.monotonic() - started, 3),
                    "seed_store": store_hashes(self.payload / "seed-home"), "test_store": store_hashes(home),
                }, indent=1))
                self.output_valid = True
            finally:
                bridge.stop()
                thread.join(timeout=5)
