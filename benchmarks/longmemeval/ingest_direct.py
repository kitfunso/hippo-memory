"""Ingest LongMemEval sessions directly into hippo's SQLite store.

Bypasses the CLI to avoid shell escaping and argument length limits on Windows.
Writes directly to the .hippo/hippo.db SQLite database.
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
from pathlib import Path
from typing import Any

from tqdm import tqdm

logger = logging.getLogger(__name__)


def load_dataset(data_path: Path) -> list[dict[str, Any]]:
    with open(data_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        for key in ("data", "questions", "entries"):
            if key in data:
                data = data[key]
                break
    if not isinstance(data, list):
        raise ValueError(f"Expected list, got {type(data).__name__}")
    logger.info("Loaded %d entries from %s", len(data), data_path)
    return data


def collect_sessions(
    entries: list[dict[str, Any]],
) -> dict[str, tuple[str, list[dict[str, str]]]]:
    sessions: dict[str, tuple[str, list[dict[str, str]]]] = {}
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
    session_id: str, date: str, turns: list[dict[str, str]]
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


def ingest_direct(
    data_path: Path,
    hippo_bin: str = "hippo",
    store_dir: Path | None = None,
) -> Path:
    import sqlite3
    import hashlib
    from datetime import datetime

    entries = load_dataset(data_path)
    sessions = collect_sessions(entries)

    if store_dir is None:
        import tempfile
        store_dir = Path(tempfile.mkdtemp(prefix="hippo_longmemeval_"))
    else:
        store_dir.mkdir(parents=True, exist_ok=True)

    logger.info("Store directory: %s", store_dir)

    # Initialize hippo store via CLI (creates schema)
    hippo_dir = store_dir / ".hippo"
    if not hippo_dir.exists():
        result = subprocess.run(
            [hippo_bin, "init", "--no-schedule"],
            cwd=str(store_dir),
            capture_output=True, text=True,
            shell=(sys.platform == "win32"),
        )
        if result.returncode != 0:
            # Try without --no-schedule
            result = subprocess.run(
                [hippo_bin, "init"],
                cwd=str(store_dir),
                capture_output=True, text=True,
                shell=(sys.platform == "win32"),
            )
        logger.info("Initialized hippo store")

    db_path = hippo_dir / "hippo.db"
    if not db_path.exists():
        raise RuntimeError(f"hippo.db not found at {db_path}")

    db = sqlite3.connect(str(db_path))
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA busy_timeout = 5000")

    now = datetime.utcnow().isoformat() + "Z"
    inserted = 0
    failed = 0

    for sid, (date, turns) in tqdm(sessions.items(), desc="Ingesting", unit="session"):
        text = format_session_text(sid, date, turns)
        mem_id = "mem_" + hashlib.sha256(sid.encode()).hexdigest()[:8]
        tags = [sid]
        if date:
            tags.append(f"date:{date}")

        try:
            db.execute(
                """INSERT INTO memories(
                    id, created, last_retrieved, retrieval_count, strength,
                    half_life_days, layer, tags_json, emotional_valence,
                    schema_fit, source, outcome_score,
                    outcome_positive, outcome_negative,
                    conflicts_with_json, pinned, confidence, content, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(id) DO UPDATE SET content=excluded.content, updated_at=datetime('now')""",
                (
                    mem_id, now, now, 0, 1.0,
                    7, "episodic", json.dumps(tags), "neutral",
                    0.5, "longmemeval", None,
                    0, 0,
                    "[]", 0, "verified", text,
                ),
            )
            inserted += 1
        except Exception as exc:
            failed += 1
            logger.warning("Failed to insert %s: %s", sid, exc)

    db.commit()

    # Backfill FTS index if available
    try:
        db.execute("""
            INSERT INTO memories_fts(id, content, tags)
            SELECT m.id, m.content, m.tags_json
            FROM memories m
            WHERE NOT EXISTS (SELECT 1 FROM memories_fts f WHERE f.id = m.id)
        """)
        db.commit()
        logger.info("FTS index updated")
    except Exception:
        logger.info("FTS not available, BM25 will use fallback")

    db.close()

    logger.info("Inserted %d/%d sessions (failed: %d)", inserted, len(sessions), failed)

    # Save metadata
    meta = {
        "data_path": str(data_path),
        "store_dir": str(store_dir),
        "total_sessions": len(sessions),
        "ingested": inserted,
        "failed": failed,
    }
    (store_dir / "ingest_metadata.json").write_text(json.dumps(meta, indent=2))

    return store_dir


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest LongMemEval sessions directly into hippo SQLite store."
    )
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--hippo", type=str, default="hippo")
    parser.add_argument("--store-dir", type=Path, default=None)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    store_dir = ingest_direct(args.data, args.hippo, args.store_dir)
    logger.info("Done. Store at: %s", store_dir)


if __name__ == "__main__":
    main()
