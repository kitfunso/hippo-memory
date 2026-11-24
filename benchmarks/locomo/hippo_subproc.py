from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from pathlib import Path

_BATCH_SUFFIXES = (".cmd", ".bat")

_REFUSAL_HINT = (
    "hippo_subproc: refusing to invoke a batch shim ({exe!r}) via subprocess. "
    "Batch files (.cmd/.bat) always execute through cmd.exe regardless of the "
    "shell= argument, so command-line content (newlines, %VAR%, ^, quotes) can "
    "be mangled or misinterpreted (the BatBadBut / CVE-2024-24576 class) -- no "
    "amount of escaping makes this safe. Set HIPPO_BIN to a real executable or "
    "a direct interpreter invocation, e.g.:\n"
    '  HIPPO_BIN="node <repo>/bin/hippo.js"\n'
    "so the hippo CLI is invoked without going through a shell at all."
)

_NOT_FOUND_HINT = (
    "hippo_subproc: could not resolve a hippo executable. Set HIPPO_BIN to "
    "either a single executable path or a command string, e.g.:\n"
    '  HIPPO_BIN="node <repo>/bin/hippo.js"\n'
    "or install `hippo` on PATH as a real executable (not a .cmd/.bat shim)."
)


class HippoResolutionError(RuntimeError):
    ...


def _is_batch_shim(executable: str) -> bool:
    return Path(executable).suffix.lower() in _BATCH_SUFFIXES


def _check_prefix_head(head: str) -> None:
    if _is_batch_shim(head):
        raise HippoResolutionError(_REFUSAL_HINT.format(exe=head))
    p = Path(head)
    if p.suffix == "" and p.parent == Path("."):
        resolved = shutil.which(head)
        if resolved is not None and _is_batch_shim(resolved):
            raise HippoResolutionError(_REFUSAL_HINT.format(exe=resolved))


def resolve_hippo_command() -> list[str]:
    hippo_bin = os.environ.get("HIPPO_BIN")
    if hippo_bin:
        command = shlex.split(hippo_bin)
        if not command:
            raise HippoResolutionError(_NOT_FOUND_HINT)
        _check_prefix_head(command[0])
        return command

    resolved = shutil.which("hippo")
    if resolved is None:
        raise HippoResolutionError(_NOT_FOUND_HINT)
    if _is_batch_shim(resolved):
        raise HippoResolutionError(_REFUSAL_HINT.format(exe=resolved))
    return [resolved]


def run_hippo_argv(
    args: list[str],
    *,
    command: list[str] | None = None,
    env: dict[str, str],
    cwd: str,
    timeout: int,
    stdin_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    if command is not None:
        if not command:
            raise HippoResolutionError(_NOT_FOUND_HINT)
        _check_prefix_head(command[0])
        prefix = command
    else:
        prefix = resolve_hippo_command()
    full_argv = [*prefix, *args]
    return subprocess.run(
        full_argv,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        shell=False,
        input=stdin_text,
        timeout=timeout,
    )
