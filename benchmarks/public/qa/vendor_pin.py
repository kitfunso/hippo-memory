"""A benchmark's own code imported from a local clone, never copied: the clone must sit at the pinned commit with each
used file equal to its pinned git blob, so a pull or an edit stops the lane before any call (notes 2026-11-17)."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def git(clone: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(clone), *args], capture_output=True, text=True, check=True).stdout.strip()


def drift(clone: Path, commit: str, blobs: dict[str, str]) -> list[str]:
    """Why the clone is not the pinned code, or [] when it is."""
    if not (clone / ".git").exists():
        return [f"{clone} is no git clone: clone it and check out {commit}"]
    out = [] if (head := git(clone, "rev-parse", "HEAD")) == commit else [f"HEAD is {head}, not {commit}"]
    # --no-filters hashes the bytes the lane reads: a CRLF checkout of an LF blob changes multi-line CSV fields (17 Nov)
    for rel, blob in blobs.items():
        if not (clone / rel).exists():
            out.append(f"{rel} is missing")
        elif (got := git(clone, "hash-object", "--no-filters", rel)) != blob:
            out.append(f"{rel} is blob {got}, not {blob}")
    return out


def check(clone: Path, commit: str, blobs: dict[str, str]) -> None:
    if bad := drift(clone, commit, blobs):
        sys.exit(f"{clone} is not the pinned code: {'; '.join(bad[:3])}")
