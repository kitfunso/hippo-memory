"""The key a client sends when its caller names none, by the rule the hippo CLI follows."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator
from urllib.parse import urlsplit

# A key file is read only for a server on this machine, so the key never leaves it.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
KEY_FILE = "server.key"


def resolve_api_key(base_url: str, api_key: str | None) -> str | None:
    """`api_key`, else HIPPO_API_KEY, else the key `hippo serve` wrote for a loopback server, else None."""
    if api_key:
        return api_key
    from_env = os.environ.get("HIPPO_API_KEY", "").strip()
    if from_env:
        return from_env
    if urlsplit(base_url).hostname not in _LOOPBACK_HOSTS:
        return None
    for path in _key_files():
        try:
            key = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if key:
            return key
    return None


def _global_root() -> Path:
    """HIPPO_HOME, else XDG_DATA_HOME/hippo, else ~/.hippo, as the CLI resolves the global store."""
    home = os.environ.get("HIPPO_HOME", "").strip()
    if home:
        return Path(home)
    xdg = os.environ.get("XDG_DATA_HOME", "").strip()
    return Path(xdg) / "hippo" if xdg else Path.home() / ".hippo"


def _key_files() -> Iterator[Path]:
    """The project store nearest the working folder first, then the global store."""
    cwd = Path.cwd()
    for folder in (cwd, *cwd.parents):
        yield folder / ".hippo" / KEY_FILE
    yield _global_root() / KEY_FILE
