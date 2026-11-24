from __future__ import annotations

import argparse
import json
import logging
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from tqdm import tqdm

logger = logging.getLogger(__name__)


def load_dataset(data_path: Path) -> list[dict[str, Any]]:
    if not data_path.exists():
        raise FileNotFoundError(f"Dataset not found: {data_path}")

    with open(data_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if isinstance(data, dict):
        for key in ("data", "questions", "entries"):
            if key in data:
                data = data[key]
                break

    if not isinstance(data, list):
        raise ValueError(f"Expected a list of entries, got {type(data).__name__}")

    logger.info("Loaded %d entries from %s", len(data), data_path)
    return data


def collect_sessions(
    entries: list[dict[str, Any]],
) -> dict[str, tuple[str, list[list[dict[str, str]]]]]:
    sessions: dict[str, tuple[str, list[list[dict[str, str]]]]] = {}

    for entry in entries:
        haystack_sessions = entry.get("haystack_sessions", [])
        session_ids = entry.get("haystack_session_ids", [])
        dates = entry.get("haystack_dates", [])

        for i, session_turns in enumerate(haystack_sessions):
            sid = session_ids[i] if i < len(session_ids) else f"session_{i}"
            date = dates[i] if i < len(dates) else ""

            if sid not in sessions:
                sessions[sid] = (date, session_turns)

    logger.info("Collected %d unique sessions", len(sessions))
    return sessions


def format_session_text(
    session_id: str,
    date: str,
    turns: list[dict[str, str]],
) -> str:
    lines: list[str] = []
    if date:
        lines.append(f"[Date: {date}]")
    lines.append(f"[Session: {session_id}]")
    lines.append("")

    for turn in turns:
        role = turn.get("role", "unknown").capitalize()
        content = turn.get("content", "")
        lines.append(f"{role}: {content}")

    return "\n".join(lines)


def run_hippo_command(
    hippo_bin: str,
    args: list[str],
    cwd: str,
    timeout: int = 30,
    stdin_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    cmd = [hippo_bin] + args
    import os
    env = {**os.environ, "HIPPO_HOME": cwd, "HOME": cwd, "USERPROFILE": cwd}
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=(sys.platform == "win32"),
            input=stdin_text,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
        if result.returncode != 0:
            logger.warning(
                "hippo command failed: %s\nstderr: %s",
                " ".join(cmd),
                result.stderr.strip(),
            )
        return result
    except FileNotFoundError:
        logger.error("hippo binary not found: %s", hippo_bin)
        raise
    except subprocess.TimeoutExpired:
        logger.error("hippo command timed out after %ds: %s", timeout, " ".join(cmd))
        raise


def ingest_sessions(
    data_path: Path,
    hippo_bin: str = "hippo",
    store_dir: Path | None = None,
    salience: bool = False,
    skip_sleep: bool = False,
) -> Path:
    entries = load_dataset(data_path)
    sessions = collect_sessions(entries)

    if store_dir is None:
        store_dir = Path(tempfile.mkdtemp(prefix="hippo_longmemeval_"))
    else:
        store_dir.mkdir(parents=True, exist_ok=True)

    logger.info("Using store directory: %s", store_dir)

    result = run_hippo_command(
        hippo_bin, ["init", "--no-hooks", "--no-schedule", "--no-learn"],
        cwd=str(store_dir),
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to initialize hippo store: {result.stderr}")
    logger.info("Initialized hippo store at %s", store_dir)

    if salience:
        hippo_dir = store_dir / ".hippo"
        hippo_dir.mkdir(parents=True, exist_ok=True)
        config_path = hippo_dir / "config.json"
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump({"salience": {"enabled": True}}, f, indent=2)
        logger.info("Wrote salience=true config to %s", config_path)
    else:
        logger.info("Salience gate disabled (default)")

    failed = 0
    for sid, (date, turns) in tqdm(
        sessions.items(), desc="Ingesting sessions", unit="session"
    ):
        text = format_session_text(sid, date, turns)

        args = ["remember", "-", "--tag", sid]
        if date:
            args.extend(["--tag", f"date:{date}"])

        try:
            result = run_hippo_command(
                hippo_bin, args, cwd=str(store_dir), timeout=60, stdin_text=text,
            )
            if result.returncode != 0:
                failed += 1
                logger.warning("Failed to ingest session %s", sid)
        except Exception as exc:
            failed += 1
            logger.warning("Exception ingesting session %s: %s", sid, exc)

    logger.info(
        "Ingested %d/%d sessions (failures: %d)",
        len(sessions) - failed,
        len(sessions),
        failed,
    )

    if skip_sleep:
        logger.info("Skipping hippo sleep (--skip-sleep). Memories preserved as-ingested.")
    else:
        logger.info("Running hippo sleep for consolidation...")
        run_hippo_command(hippo_bin, ["sleep"], cwd=str(store_dir), timeout=900)

    metadata = {
        "data_path": str(data_path),
        "store_dir": str(store_dir),
        "total_sessions": len(sessions),
        "ingested": len(sessions) - failed,
        "failed": failed,
    }
    meta_path = store_dir / "ingest_metadata.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    return store_dir


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest LongMemEval sessions into a hippo memory store."
    )
    parser.add_argument(
        "--data",
        type=Path,
        required=True,
        help="Path to LongMemEval JSON dataset.",
    )
    parser.add_argument(
        "--hippo",
        type=str,
        default="hippo",
        help="Path to hippo CLI binary (default: hippo).",
    )
    parser.add_argument(
        "--store-dir",
        type=Path,
        default=None,
        help="Directory for .hippo/ store (default: temp directory).",
    )
    parser.add_argument(
        "--salience",
        action="store_true",
        help="Enable the pineal salience gate (default off — see ingest_sessions docstring).",
    )
    parser.add_argument(
        "--skip-sleep",
        action="store_true",
        help="Skip the hippo sleep consolidation step (preserves all ingested sessions).",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging.",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    try:
        store_dir = ingest_sessions(
            args.data, args.hippo, args.store_dir,
            salience=args.salience, skip_sleep=args.skip_sleep,
        )
        logger.info("Ingestion complete. Store at: %s", store_dir)
    except Exception:
        logger.exception("Ingestion failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
