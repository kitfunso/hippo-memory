"""Safe subprocess invocation for the hippo CLI (LoCoMo harness only).

Root cause this module fixes: `run_hippo` in `run.py` and
`audit_matched_stores.py` used `shell=(sys.platform == "win32")`. On
Windows, `subprocess.run` with `shell=True` builds a `cmd.exe /c <line>`
command line, and cmd.exe truncates that line at the first embedded
newline. Any LoCoMo turn whose source text ends with `"\n"` silently lost
its closing quote and every `--tag` argument after it — exit code stayed 0
because the truncated line was still valid shell syntax. See
`../LOCOMO_INVESTIGATION.md` ("Correction 2026-07-05") for the full proof
chain.

This module never sets `shell=True`. Content and tags are always passed as
argv list elements, so cmd.exe's line parsing never gets a chance to see
them. Batch shims (`hippo.cmd` / `hippo.bat`, e.g. an npm global install)
are refused outright rather than special-cased: `CreateProcess` on a
`.cmd`/`.bat` target transits `cmd.exe` regardless of the `shell=` argument
you pass to `subprocess.run` (the BatBadBut / CVE-2024-24576 class), so no
combination of quoting or escaping makes a batch-shim target safe for
argv content that may itself contain metacharacters. Point `HIPPO_BIN` at
a real executable or a `node <path>` invocation instead.
"""

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
    """Raised when a safe hippo invocation command cannot be resolved."""


def _is_batch_shim(executable: str) -> bool:
    return Path(executable).suffix.lower() in _BATCH_SUFFIXES


def resolve_hippo_command() -> list[str]:
    """Resolve the default argv prefix used to invoke hippo.

    Resolution order: `HIPPO_BIN` (shlex-split; may be a single executable
    path or a full command string such as `node <repo>/bin/hippo.js`), else
    `shutil.which("hippo")`. Raises `HippoResolutionError` if the resolved
    executable is a `.cmd`/`.bat` batch shim, or if nothing resolves at all.
    Never returns a value that could cause `None` to reach `subprocess.run`.
    """
    hippo_bin = os.environ.get("HIPPO_BIN")
    if hippo_bin:
        command = shlex.split(hippo_bin)
        if not command:
            raise HippoResolutionError(_NOT_FOUND_HINT)
        if _is_batch_shim(command[0]):
            raise HippoResolutionError(_REFUSAL_HINT.format(exe=command[0]))
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
    """Run a hippo CLI invocation safely, with content passed via argv.

    `command` is an explicit argv prefix (e.g. `["node", "C:/repo/bin/hippo.js"]`)
    used verbatim when given -- this preserves `audit_matched_stores.py`'s
    multi-build `--hippo-cmd` capability, which must be able to target a
    specific build regardless of `HIPPO_BIN`. When `command` is omitted, the
    default resolution (`HIPPO_BIN` else `shutil.which("hippo")`) is used via
    `resolve_hippo_command()`.

    `shell` is never set to True. Turn text and tags are passed as separate
    argv elements exactly as given -- no normalization, no quoting games.

    The batch-shim refusal applies to explicit `command` prefixes too: an
    explicit `.cmd`/`.bat` path executes through cmd.exe under CreateProcess
    regardless of shell=False (the BatBadBut vector), so
    `--hippo-cmd current=hippo.cmd` would silently reopen the truncation
    bug on the audit path without this check.
    """
    if command is not None:
        if not command:
            raise HippoResolutionError(_NOT_FOUND_HINT)
        if _is_batch_shim(command[0]):
            raise HippoResolutionError(_REFUSAL_HINT.format(exe=command[0]))
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
