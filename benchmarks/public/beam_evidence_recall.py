"""Free retrieval check on Mem0-runner BEAM output (no model calls).

For each question, the share of its source turns (`source_chat_ids`, the turn
`id`s the question was written from) whose text appears in the top k retrieved
memories, from `--predict-only` output of mem0ai/memory-benchmarks. Sibling of
longmemeval_evidence_recall.py; see docs/evals/2026-09-24-public-benchmarks-prereg.md
Amendment 4. Usage:

    python beam_evidence_recall.py --dataset-dir datasets/beam \
        --run-dir out/predicted_<name> [--k 10,50,200] [--baseline out/predicted_<other>]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from collections import defaultdict

from longmemeval_evidence_recall import boot


def turns_of(chat: object) -> list[dict]:
    """Every turn dict in a BEAM chat, whichever of the three storage formats it uses."""
    if isinstance(chat, dict):
        if "role" in chat and "content" in chat:
            return [chat]
        return [t for v in chat.values() for t in turns_of(v)]
    if isinstance(chat, list):
        return [t for v in chat for t in turns_of(v)]
    return []


def turn_text(turn: dict) -> str:
    """The line hippo-mem0-server.mjs stores for this turn, after the runner's role mapping."""
    role = turn.get("role", "user")
    if role not in ("user", "assistant"):
        role = "user" if role.lower() in ("human", "user") else "assistant"
    return f"{role}: {str(turn.get('content', '')).strip()}"


def source_ids(raw: object) -> list[int]:
    if isinstance(raw, dict):
        return [i for v in raw.values() for i in source_ids(v)]
    if isinstance(raw, list):
        return [i for v in raw for i in source_ids(v)]
    return [raw] if isinstance(raw, int) else []


class Evidence:
    """Turn texts by (chat size, conversation index, turn id), loaded per size on demand."""

    def __init__(self, dataset_dir: str) -> None:
        self.dir = dataset_dir
        self.by_size: dict[str, list[dict[int, list[str]]]] = {}

    def texts(self, size: str, conv: int, ids: list[int]) -> list[str] | None:
        """Source turn texts, or None when an id names two turns (four 1M conversations restart their ids)."""
        if size not in self.by_size:
            convs = json.load(open(os.path.join(self.dir, f"beam_{size}.json"), encoding="utf-8"))
            self.by_size[size] = []
            for c in convs:
                by_id: dict[int, list[str]] = defaultdict(list)
                for t in turns_of(c.get("chat", [])):
                    by_id[t["id"]].append(turn_text(t))
                self.by_size[size].append(by_id)
        by_id = self.by_size[size][conv]
        missing = [i for i in ids if i not in by_id]
        if missing:
            raise ValueError(f"{size}_{conv}: source ids {missing} are not turn ids")
        if any(len(by_id[i]) > 1 for i in ids):
            return None
        # A turn with no text never reaches the store, in any arm.
        return [t for t in (by_id[i][0] for i in dict.fromkeys(ids)) if t.split(": ", 1)[1]]


def score_run(run_dir: str, evidence: Evidence, ks: list[int]) -> tuple[dict, dict, dict]:
    """agg[(size, type)][metric] -> values; per_q[k] -> {question_id: recall}; dropped[size] -> count."""
    agg: dict = defaultdict(lambda: defaultdict(list))
    per_q: dict = defaultdict(dict)
    dropped: dict = defaultdict(int)
    for f in sorted(glob.glob(os.path.join(run_dir, "*.json"))):
        if os.path.basename(f).startswith("_"):
            continue  # ingestion checkpoint, not a scored question
        q = json.load(open(f, encoding="utf-8"))
        ev = evidence.texts(q["chat_size"], q["conversation_idx"], source_ids(q.get("source_chat_ids")))
        if ev is None:
            dropped[q["chat_size"]] += 1
            continue
        if not ev:
            continue  # abstention questions have no source turns
        mems = [r["memory"] for r in q["retrieval"]["search_results"]]
        for k in ks:
            top = "\n".join(mems[:k])
            recall = sum(e in top for e in ev) / len(ev)
            per_q[k][q["question_id"]] = recall
            for key in ((q["chat_size"], "all"), (q["chat_size"], q["question_type"])):
                agg[key][f"recall@{k}"].append(recall)
    return agg, per_q, dropped


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset-dir", required=True, help="the runner's datasets/beam cache")
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--k", default="10,50,200")
    ap.add_argument("--baseline", default=None, help="run-dir to compare against, paired bootstrap")
    ap.add_argument("--draws", type=int, default=4000)
    a = ap.parse_args()
    ks = [int(x) for x in a.k.split(",")]
    evidence = Evidence(a.dataset_dir)
    agg, per_q, dropped = score_run(a.run_dir, evidence, ks)
    for (size, typ), m in sorted(agg.items(), key=lambda kv: (kv[0][0], kv[0][1] != "all", kv[0][1])):
        n = len(next(iter(m.values())))
        cells = "  ".join(f"{name} {100 * sum(v) / len(v):.1f}" for name, v in m.items())
        print(f"{size:>4} {typ:>24} n={n:<4} {cells}")
    for size, n in sorted(dropped.items()):
        print(f"{size} dropped, a source id names two turns: {n}")
    if a.baseline:
        _, base_q, _ = score_run(a.baseline, evidence, ks)
        sizes = sorted({qid.split("_", 1)[0] for qid in per_q[ks[0]]})
        for size in sizes:
            for k in ks:
                ids = sorted(i for i in set(per_q[k]) & set(base_q[k]) if i.startswith(f"{size}_"))
                d, lo, hi = boot([per_q[k][i] - base_q[k][i] for i in ids], a.draws)
                print(f"{size} minus baseline recall@{k}: {100 * d:+.1f} [{100 * lo:+.1f}, {100 * hi:+.1f}] n={len(ids)}")


if __name__ == "__main__":
    main()
