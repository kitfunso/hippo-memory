"""Each arm's hippo-mem0-server flags and the /health that proves them (prereg Amendment 6, dated notes 5 and 9).
Every harness starts its servers from here, so an arm has one flag set."""
from __future__ import annotations

import re
from pathlib import Path

SERVER_ARM = {"hippo365": "hippo", "bm25": "bm25", "hippo-emb": "hippo", "hippo-best": "hippo", "hippo-rank": "hippo"}
FLAGS = {"hippo-emb": ["--embeddings", "1"],
         "hippo-best": ["--embeddings", "1", "--reranker-top-k", "50", "--rank-score"],
         "hippo-rank": ["--embeddings", "1", "--rank-score"]}  # retrieval only: hippo-best without the cross-encoder


def want_health(arm: str, read_only: bool = False) -> dict:
    """What /health must report for the arm, so no arm is searched with another arm's settings."""
    f = FLAGS.get(arm, [])
    return {"arm": SERVER_ARM[arm], "embeddings": "--embeddings" in f, "readOnly": read_only,
            "rankScore": "--rank-score" in f,
            "rerankerTopK": int(f[f.index("--reranker-top-k") + 1]) if "--reranker-top-k" in f else 0}


def health_ok(arm: str, health: dict, read_only: bool = False) -> bool:
    want = want_health(arm, read_only)
    return {k: health.get(k) for k in want} == want


# hippo's warn line for a search on BM25 alone (src/domain/search/vector.ts warnBm25Fallback); /health cannot show it
FELL_BACK = re.compile(r"fell back", re.IGNORECASE)


def fallback_logs(logs) -> list[str]:
    """The server logs that hold a search on BM25 alone; hippo writes the first of each reason at warn."""
    return [str(p) for p in logs if FELL_BACK.search(Path(p).read_text(encoding="utf-8", errors="replace"))]
