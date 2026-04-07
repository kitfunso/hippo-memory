"""Fast retrieval using SQLite FTS5 directly, bypassing hippo CLI.

Eliminates subprocess overhead: one process, one DB connection, all 500 queries.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sqlite3
import sys
from math import log2
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
    return data


def tokenize(text: str) -> list[str]:
    """Simple tokenizer matching hippo's BM25 approach."""
    return [w for w in re.sub(r"[^\w\s]", " ", text.lower()).split() if len(w) > 2]


def fts_escape(term: str) -> str:
    """Escape a term for FTS5 query."""
    return '"' + term.replace('"', '""') + '"'


def recall_fts(
    db: sqlite3.Connection,
    query: str,
    top_k: int = 10,
) -> list[dict[str, Any]]:
    """Retrieve memories using FTS5 full-text search."""
    tokens = tokenize(query)
    if not tokens:
        return []

    # Use OR for broader matching, limit terms to avoid query explosion
    search_terms = tokens[:20]
    fts_query = " OR ".join(fts_escape(t) for t in search_terms)

    try:
        rows = db.execute(
            """SELECT m.id, m.content, m.tags_json, m.strength, m.half_life_days,
                      m.retrieval_count, m.emotional_valence,
                      rank
               FROM memories_fts f
               JOIN memories m ON m.id = f.id
               WHERE memories_fts MATCH ?
               ORDER BY rank
               LIMIT ?""",
            (fts_query, top_k),
        ).fetchall()
    except sqlite3.OperationalError as e:
        logger.debug("FTS query failed: %s", e)
        return recall_like(db, query, top_k)

    results = []
    for row in rows:
        tags = []
        try:
            tags = json.loads(row[2]) if row[2] else []
        except json.JSONDecodeError:
            pass

        results.append({
            "id": row[0],
            "content": row[1],
            "tags": tags,
            "score": -row[7],  # FTS5 rank is negative (lower = better)
            "strength": row[3],
        })

    return results


def recall_like(
    db: sqlite3.Connection,
    query: str,
    top_k: int = 10,
) -> list[dict[str, Any]]:
    """Fallback: LIKE-based search when FTS fails."""
    tokens = tokenize(query)
    if not tokens:
        return []

    # Score each memory by token overlap
    all_rows = db.execute(
        "SELECT id, content, tags_json, strength FROM memories"
    ).fetchall()

    scored = []
    for row in all_rows:
        content_lower = row[1].lower()
        hits = sum(1 for t in tokens if t in content_lower)
        if hits > 0:
            score = hits / len(tokens)
            scored.append((score, row))

    scored.sort(key=lambda x: x[0], reverse=True)

    results = []
    for score, row in scored[:top_k]:
        tags = []
        try:
            tags = json.loads(row[2]) if row[2] else []
        except json.JSONDecodeError:
            pass
        results.append({
            "id": row[0],
            "content": row[1],
            "tags": tags,
            "score": score,
            "strength": row[3],
        })

    return results


def retrieve_all_fast(
    data_path: Path,
    store_dir: Path,
    output_path: Path,
    top_k: int = 10,
) -> Path:
    entries = load_dataset(data_path)
    logger.info("Retrieving for %d questions from %s", len(entries), store_dir)

    db_path = store_dir / ".hippo" / "hippo.db"
    if not db_path.exists():
        raise FileNotFoundError(f"hippo.db not found: {db_path}")

    db = sqlite3.connect(str(db_path))
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA busy_timeout = 5000")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    empty = 0
    with open(output_path, "w", encoding="utf-8") as f:
        for entry in tqdm(entries, desc="Retrieving", unit="q"):
            question = entry.get("question", "")
            memories = recall_fts(db, question, top_k=top_k)

            if not memories:
                empty += 1

            result = {
                "question_id": entry.get("question_id", ""),
                "question": question,
                "answer": entry.get("answer", ""),
                "question_type": entry.get("question_type", ""),
                "question_date": entry.get("question_date", ""),
                "retrieved_memories": memories,
                "num_retrieved": len(memories),
            }
            f.write(json.dumps(result, ensure_ascii=False) + "\n")

    db.close()
    logger.info("Done. %d/%d had results, %d empty", len(entries) - empty, len(entries), empty)
    return output_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fast LongMemEval retrieval using SQLite FTS5 directly."
    )
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--store-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("results/retrieval.jsonl"))
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    retrieve_all_fast(args.data, args.store_dir, args.output, args.top_k)


if __name__ == "__main__":
    main()
