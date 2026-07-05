"""Tests for hippo_subproc.py -- argv fidelity + batch-shim refusal.

Self-contained: no hippo binary required. HIPPO_BIN is stubbed with a
throwaway python script (written to tmp_path per test) that records
sys.argv + stdin to a JSON file. These are regression guards for the FIXED
contract (argv reaches the child byte-exact, batch shims refused); they do
not re-run the removed shell=True path that originally lost tags in
production (cmd.exe truncating the command line at the first embedded
newline in turn text -- see ../LOCOMO_INVESTIGATION.md, "Correction
2026-07-05").
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import sys
from pathlib import Path

import pytest

from hippo_subproc import HippoResolutionError, run_hippo_argv

STUB_SCRIPT_SRC = """\
import json
import os
import sys

record = {"argv": sys.argv, "stdin": sys.stdin.read()}
with open(os.environ["HIPPO_STUB_OUTPUT"], "w", encoding="utf-8") as f:
    json.dump(record, f)
"""


def write_stub(tmp_path: Path) -> Path:
    stub_path = tmp_path / "hippo_stub.py"
    stub_path.write_text(STUB_SCRIPT_SRC, encoding="utf-8")
    return stub_path


def quoted_command(*parts: str) -> str:
    """Build a HIPPO_BIN command string that survives shlex.split (posix mode).

    Forward slashes only (matches the documented HIPPO_BIN convention) so
    posix-mode shlex splitting never mistakes a Windows backslash for an
    escape character.
    """
    return " ".join(shlex.quote(Path(part).as_posix()) for part in parts)


def run_stub(
    tmp_path: Path,
    args: list[str],
    *,
    command: list[str] | None = None,
    stdin_text: str = "",
) -> dict:
    output_path = tmp_path / "record.json"
    env = {**os.environ, "HIPPO_STUB_OUTPUT": str(output_path)}
    result = run_hippo_argv(
        args,
        command=command,
        env=env,
        cwd=str(tmp_path),
        timeout=30,
        stdin_text=stdin_text,
    )
    assert result.returncode == 0, f"stub failed: {result.stderr}"
    return json.loads(output_path.read_text(encoding="utf-8"))


# --- (a)/(b)/(c): byte-exact argv content ---


def test_trailing_newline_content_and_tags_byte_exact(tmp_path, monkeypatch):
    stub_path = write_stub(tmp_path)
    monkeypatch.setenv("HIPPO_BIN", quoted_command(sys.executable, str(stub_path)))

    text = "Kit: heading to the store now\n"
    tags = ["conv:sample-1", "session:3", "speaker:Kit", "dia:D3:12"]
    args = ["remember", text]
    for tag in tags:
        args.extend(["--tag", tag])

    record = run_stub(tmp_path, args)
    received = record["argv"][1:]  # drop the stub script's own argv[0]
    assert received == args
    assert received[1] == text  # exact trailing newline preserved


def test_percent_content_byte_exact(tmp_path, monkeypatch):
    stub_path = write_stub(tmp_path)
    monkeypatch.setenv("HIPPO_BIN", quoted_command(sys.executable, str(stub_path)))

    text = "%PATH% and 100% off"
    args = ["remember", text, "--tag", "conv:sample-2"]

    record = run_stub(tmp_path, args)
    received = record["argv"][1:]
    assert received == args
    assert received[1] == text


def test_interior_newline_content_byte_exact(tmp_path, monkeypatch):
    stub_path = write_stub(tmp_path)
    monkeypatch.setenv("HIPPO_BIN", quoted_command(sys.executable, str(stub_path)))

    text = "first line\nsecond line\nthird line"
    args = ["remember", text, "--tag", "conv:sample-3", "--tag", "dia:D1:2"]

    record = run_stub(tmp_path, args)
    received = record["argv"][1:]
    assert received == args
    assert received[1] == text


# --- (d): .cmd/.bat shim refusal ---


@pytest.mark.parametrize("suffix", [".cmd", ".bat"])
def test_batch_shim_hippo_bin_refused(tmp_path, monkeypatch, suffix):
    shim_path = tmp_path / f"hippo{suffix}"
    shim_path.write_text("@echo off\n", encoding="utf-8")
    monkeypatch.setenv("HIPPO_BIN", quoted_command(str(shim_path)))

    with pytest.raises(HippoResolutionError) as exc_info:
        run_hippo_argv(
            ["--version"],
            env=os.environ.copy(),
            cwd=str(tmp_path),
            timeout=5,
        )
    message = str(exc_info.value)
    assert "HIPPO_BIN" in message
    assert suffix in message or "batch" in message.lower()


def test_batch_shim_from_path_resolution_refused(tmp_path, monkeypatch):
    monkeypatch.delenv("HIPPO_BIN", raising=False)
    shim_path = tmp_path / "hippo.cmd"
    shim_path.write_text("@echo off\n", encoding="utf-8")
    monkeypatch.setattr(shutil, "which", lambda name: str(shim_path))

    with pytest.raises(HippoResolutionError) as exc_info:
        run_hippo_argv(
            ["--version"],
            env=os.environ.copy(),
            cwd=str(tmp_path),
            timeout=5,
        )
    assert "HIPPO_BIN" in str(exc_info.value)


# --- (e): explicit command= used verbatim, HIPPO_BIN ignored ---


def test_explicit_command_overrides_hippo_bin(tmp_path, monkeypatch):
    stub_path = write_stub(tmp_path)
    # Point HIPPO_BIN at something that would fail if it were ever consulted.
    monkeypatch.setenv("HIPPO_BIN", "definitely-not-a-real-hippo-binary")

    args = ["remember", "hello world", "--tag", "conv:sample-4"]
    record = run_stub(tmp_path, args, command=[sys.executable, str(stub_path)])
    received = record["argv"][1:]
    assert received == args


# --- (g): explicit command= prefixes get the same batch-shim refusal ---


@pytest.mark.parametrize("suffix", [".cmd", ".bat"])
def test_explicit_command_batch_shim_refused(tmp_path, suffix):
    shim = tmp_path / f"other-build{suffix}"
    shim.write_text("@echo off\n", encoding="utf-8")

    with pytest.raises(HippoResolutionError, match="batch shim"):
        run_hippo_argv(
            ["--version"],
            command=[str(shim)],
            env=dict(os.environ),
            cwd=str(tmp_path),
            timeout=10,
        )


def test_explicit_command_empty_list_refused(tmp_path):
    with pytest.raises(HippoResolutionError):
        run_hippo_argv(
            ["--version"],
            command=[],
            env=dict(os.environ),
            cwd=str(tmp_path),
            timeout=10,
        )


# --- (f): no HIPPO_BIN, nothing on PATH ---


def test_no_hippo_bin_and_nothing_on_path_raises(tmp_path, monkeypatch):
    monkeypatch.delenv("HIPPO_BIN", raising=False)
    monkeypatch.setattr(shutil, "which", lambda name: None)

    with pytest.raises(HippoResolutionError) as exc_info:
        run_hippo_argv(
            ["--version"],
            env=os.environ.copy(),
            cwd=str(tmp_path),
            timeout=5,
        )
    assert "HIPPO_BIN" in str(exc_info.value)


# --- (h): bare names that PATH-resolve to a batch shim are refused ---


@pytest.mark.parametrize("via_command", [True, False])
def test_bare_name_resolving_to_batch_shim_refused(tmp_path, monkeypatch, via_command):
    shim = tmp_path / "hippo-v032.cmd"
    shim.write_text("@echo off\n", encoding="utf-8")
    monkeypatch.setattr(shutil, "which", lambda name: str(shim) if name == "hippo-v032" else None)

    kwargs = dict(env=dict(os.environ), cwd=str(tmp_path), timeout=10)
    with pytest.raises(HippoResolutionError, match="batch shim"):
        if via_command:
            run_hippo_argv(["--version"], command=["hippo-v032"], **kwargs)
        else:
            monkeypatch.setenv("HIPPO_BIN", "hippo-v032")
            run_hippo_argv(["--version"], **kwargs)
