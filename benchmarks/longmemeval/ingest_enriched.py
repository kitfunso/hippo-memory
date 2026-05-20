"""Ingest LongMemEval sessions with subagent-extracted entry-level signals.

Variant of `ingest_direct.py` that consumes `signals.jsonl` (one record per
session_id with `confidence`, `kind`, `schema_fit`, `strength`,
`outcome_positive`, `outcome_negative`) produced by Plan F10 Task 5. Writes
the actual values into the `memories` table instead of the neutral defaults
used by the F6 ingest path.

Sessions whose `session_id` is absent from `signals.jsonl` fall back to the
neutral defaults (and the fallback rate is recorded in the result-doc
Provenance section).

Per `docs/plans/2026-05-11-r5-track3-richer-ingest.md` Task 6.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from tqdm import tqdm

logger = logging.getLogger(__name__)


DEFAULT_SIGNALS = {
    "confidence": "verified",
    "kind": "episodic",
    "schema_fit": 0.5,
    "strength": 1.0,
    "outcome_positive": 0,
    "outcome_negative": 0,
}


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


def load_signals(signals_path: Path) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    with open(signals_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            sid = rec.get("session_id")
            if not sid:
                continue
            # Clip / coerce to safe ranges.
            out[sid] = {
                "confidence": rec.get("confidence", DEFAULT_SIGNALS["confidence"]),
                "kind": rec.get("kind", DEFAULT_SIGNALS["kind"]),
                "schema_fit": max(0.0, min(1.0, float(rec.get("schema_fit", DEFAULT_SIGNALS["schema_fit"])))),
                "strength": max(0.0, min(2.0, float(rec.get("strength", DEFAULT_SIGNALS["strength"])))),
                "outcome_positive": max(0, min(3, int(rec.get("outcome_positive", 0)))),
                "outcome_negative": max(0, min(3, int(rec.get("outcome_negative", 0)))),
            }
    logger.info("Loaded %d signal records from %s", len(out), signals_path)
    return out


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


def ingest_enriched(
    data_path: Path,
    signals_path: Path,
    hippo_bin: str = "hippo",
    store_dir: Path | None = None,
) -> Path:
    entries = load_dataset(data_path)
    sessions = collect_sessions(entries)
    signals = load_signals(signals_path)

    if store_dir is None:
        import tempfile
        store_dir = Path(tempfile.mkdtemp(prefix="hippo_longmemeval_enriched_"))
    else:
        store_dir.mkdir(parents=True, exist_ok=True)

    logger.info("Store directory: %s", store_dir)

    hippo_dir = store_dir / ".hippo"
    abs_store = str(store_dir.resolve())
    init_env = {**os.environ, "HIPPO_HOME": abs_store, "HOME": abs_store, "USERPROFILE": abs_store}
    if not hippo_dir.exists():
        result = subprocess.run(
            [hippo_bin, "init", "--no-hooks", "--no-schedule", "--no-learn"],
            cwd=abs_store,
            capture_output=True, text=True,
            shell=(sys.platform == "win32"),
            env=init_env,
        )
        if result.returncode != 0:
            result = subprocess.run(
                [hippo_bin, "init", "--no-schedule"],
                cwd=abs_store,
                capture_output=True, text=True,
                shell=(sys.platform == "win32"),
                env=init_env,
            )
        logger.info("init rc=%s", result.returncode)

    db_path = hippo_dir / "hippo.db"
    if not db_path.exists():
        seed_result = subprocess.run(
            [hippo_bin, "remember", "schema-seed-dummy", "--tag", "_schema_seed"],
            cwd=abs_store,
            capture_output=True, text=True,
            shell=(sys.platform == "win32"),
            env=init_env,
        )
        logger.info("seed remember rc=%s", seed_result.returncode)
        if not db_path.exists():
            raise RuntimeError(f"hippo.db not found at {db_path} after seed")

    db = sqlite3.connect(str(db_path))
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA busy_timeout = 5000")

    now = datetime.utcnow().isoformat() + "Z"
    inserted = 0
    failed = 0
    fallback_count = 0

    for sid, (date, turns) in tqdm(sessions.items(), desc="Ingesting", unit="session"):
        text = format_session_text(sid, date, turns)
        mem_id = "mem_" + hashlib.sha256(sid.encode()).hexdigest()[:8]
        tags = [sid]
        if date:
            tags.append(f"date:{date}")

        sig = signals.get(sid)
        if sig is None:
            sig = DEFAULT_SIGNALS
            fallback_count += 1

        # `kind` namespace mismatch: the F10 prompt extracted content-type
        # values (episodic|semantic|procedural) but the DB schema (src/db.ts
        # triggers) and features.ts KIND_WEIGHT use lifecycle values
        # (raw|distilled|superseded|archived). The prompt's `kind` is therefore
        # discarded for this F10 run; all sessions get kind='raw' (the
        # default for freshly-ingested content). Documented as a known
        # limitation in the F10 result doc — the other 4 signals
        # (confidence, schema_fit, strength, outcome_positive/negative)
        # carry the experiment.
        try:
            db.execute(
                """INSERT INTO memories(
                    id, created, last_retrieved, retrieval_count, strength,
                    half_life_days, layer, tags_json, emotional_valence,
                    schema_fit, source, outcome_score,
                    outcome_positive, outcome_negative,
                    conflicts_with_json, pinned, confidence, content, updated_at,
                    kind
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
                ON CONFLICT(id) DO UPDATE SET content=excluded.content, updated_at=datetime('now')""",
                (
                    mem_id, now, now, 0, sig["strength"],
                    7, "episodic", json.dumps(tags), "neutral",
                    sig["schema_fit"], "longmemeval", None,
                    sig["outcome_positive"], sig["outcome_negative"],
                    "[]", 0, sig["confidence"], text,
                    "raw",
                ),
            )
            inserted += 1
        except Exception as exc:
            failed += 1
            logger.warning("Failed to insert %s: %s", sid, exc)

    db.commit()

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

    logger.info(
        "Inserted %d/%d sessions (failed: %d, signal-fallback: %d)",
        inserted, len(sessions), failed, fallback_count,
    )

    meta = {
        "data_path": str(data_path),
        "signals_path": str(signals_path),
        "store_dir": str(store_dir),
        "total_sessions": len(sessions),
        "ingested": inserted,
        "failed": failed,
        "signal_fallback_count": fallback_count,
    }
    (store_dir / "ingest_metadata.json").write_text(json.dumps(meta, indent=2))

    return store_dir


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest LongMemEval sessions with enriched entry-level signals."
    )
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--signals", type=Path, required=True)
    parser.add_argument("--hippo", type=str, default="hippo")
    parser.add_argument("--store-dir", type=Path, default=None)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    store_dir = ingest_enriched(args.data, args.signals, args.hippo, args.store_dir)
    logger.info("Done. Store at: %s", store_dir)


if __name__ == "__main__":
    main()
