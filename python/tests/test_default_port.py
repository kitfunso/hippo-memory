from __future__ import annotations

import inspect
import re
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from hippo_memory import Hippo, HippoSync

DEFAULTS_TS = Path(__file__).resolve().parents[2] / "src" / "surface" / "server" / "defaults.ts"


def _server_default_port() -> int:
    match = re.search(r"DEFAULT_SERVER_PORT\s*=\s*(\d+)", DEFAULTS_TS.read_text(encoding="utf-8"))
    assert match, f"DEFAULT_SERVER_PORT not found in {DEFAULTS_TS}"
    return int(match.group(1))


@pytest.mark.parametrize("client_class", [Hippo, HippoSync])
def test_default_base_url_uses_the_server_default_port(client_class: type) -> None:
    default = inspect.signature(client_class.__init__).parameters["base_url"].default
    assert urlsplit(default).port == _server_default_port()
