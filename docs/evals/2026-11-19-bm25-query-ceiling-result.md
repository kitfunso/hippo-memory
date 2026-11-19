# Result, 2026-11-19: BM25 divided by the query's full-match score in hybrid recall

Prereg: `docs/evals/2026-11-19-bm25-query-ceiling-prereg.md` (commit `2bd305f6c`, before the full run).

**Verdict: do not ship.** Evidence recall@10 fell 3.8 points, and the interval lies below zero. The change is reverted on this branch, so the merge carries only this note and the prereg.

**Harness gate: pass.** The master build gave back all 1,540 saved hippo-emb files exactly. The new build changed the top-10 order on 1,510 of them. Run time 685.6 s on a copy of `stores-v3/locomo-hippo-emb`.

**Primary.** `evidence_recall.py --k 5,10,50 --baseline`, 1,531 questions with evidence (9 of the 1,540 have none in the dataset).

| | base (master) | new | new minus base, 95% interval |
|---|---|---|---|
| recall@5 | 47.7 | 43.6 | -4.1 [-5.5, -2.7] |
| recall@10 | 55.7 | 52.0 | -3.8 [-5.1, -2.5] |
| recall@50 | 74.1 | 73.4 | -0.7 [-1.9, +0.5] |

Recall@10 by category, base to new: single-hop 64.7 to 59.1 (n=841), temporal 67.0 to 64.7 (n=320), multi-hop 24.8 to 24.1 (n=281), open-domain 27.8 to 26.8 (n=89).

**Why it lost.** A LoCoMo conversation store holds 369 to 689 memories, so IDF already discounts common words. Giving the best keyword match the full BM25 weight helps most on single-hop questions, which name specific people and things. The full-match divisor assumes a memory that holds every query word. Few memories do, and a query word that no memory holds adds the largest IDF to the divisor. The top 10 changed on 1,510 of 1,540 queries, so the divisor passed the pool's best there, and every keyword match lost weight against the vector.

**What the 18 Nov quirk is.** `tokenize` keeps every word ("how did the release go out" gives all six), so BM25 depends on IDF to discount common words. In a 3-memory store, IDF has almost no data, and one shared common word takes the full weight. The quirk is a small-store effect. This run shows the general fix costs recall at real store sizes.

**Routes not taken.** (1) A lower BM25 weight while a store is small, for example scaled by store size. No benchmark here has small stores, so this cannot pass a prereg yet. (2) A stopword list in `tokenize`. That changes every BM25 score and every published retrieval number, so it needs its own prereg on LoCoMo and LongMemEval.

**Reproduce.** The script below ran with `HIPPO_MODEL_CACHE` set to a cache that holds `Xenova/all-MiniLM-L6-v2`, the master build in `<worktree>/.dist-base` and the change in `<worktree>/dist`:

    python -I replay_two_builds.py --wt <worktree> --store <copy of stores-v3/locomo-hippo-emb> --out <dir> --port 8961
    python -X utf8 -I benchmarks/public/evidence_recall.py --dataset ~/hippo-bench/locomo/data/locomo10.json \
        --run-dir <dir>/new/predicted_locomo-hippo-emb --baseline <dir>/base/predicted_locomo-hippo-emb --k 5,10,50

`-X utf8` is needed on Windows: `-I` ignores `PYTHONUTF8`, and the saved files hold UTF-8 text.

<details><summary>replay_two_builds.py</summary>

```python
"""Replays the saved LoCoMo hippo-emb queries on a copy of the kept store against two hippo builds, no model calls.

Base is the master build, new is the BM25 change. Gate: base must give back every saved hippo-emb file's results
exactly, which shows the harness and store are the ones the saved run used. Writes runner-shaped files per build for
evidence_recall.py. Usage: python -I replay_two_builds.py --wt DIR --store DIR --out DIR [--limit N] [--port 8951]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

SAVED = Path.home() / "hippo-bench" / "retrieval-emb-locomo" / "predicted_locomo-hippo-emb"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wt", required=True, type=Path)
    ap.add_argument("--store", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--port", type=int, default=8951)
    a = ap.parse_args()
    pub = a.wt / "benchmarks" / "public"
    sys.path[:0] = [str(pub / "mem0"), str(pub / "qa"), str(pub)]
    import harness  # noqa: PLC0415
    from replay_locomo import client_order, TOP_K  # noqa: PLC0415

    dists = {a.port: str(a.wt / ".dist-base"), a.port + 1: str(a.wt / "dist")}
    plain = harness.server_args
    harness.server_args = lambda arm, port, data, ro=False: [*plain(arm, port, data, ro), "--dist", dists[port]]

    files = sorted(f for f in SAVED.glob("*.json") if not f.name.startswith("_"))[: a.limit or None]
    saved = [json.loads(f.read_text(encoding="utf-8")) for f in files]
    runs = {"base": a.out / "base" / "predicted_locomo-hippo-emb", "new": a.out / "new" / "predicted_locomo-hippo-emb"}
    for d in runs.values():
        d.mkdir(parents=True, exist_ok=True)
    started, base_same, top10_changed = time.time(), 0, 0
    with harness.Server("hippo-emb", a.port, a.store, a.out / "server-base.log", True) as base, \
            harness.Server("hippo-emb", a.port + 1, a.store, a.out / "server-new.log", True) as new:
        for rec in saved:
            body = {"query": rec["retrieval"]["search_query"], "user_id": rec["user_id"], "limit": TOP_K}
            got = {name: client_order(srv.call("POST", "/search", body)["results"]) for name, srv in
                   (("base", base), ("new", new))}
            base_same += got["base"] == rec["retrieval"]["search_results"]
            top10_changed += [r["id"] for r in got["base"][:10]] != [r["id"] for r in got["new"][:10]]
            for name, results in got.items():
                out = {**rec, "retrieval": {"search_query": body["query"], "search_results": results,
                                            "total_results": len(results)}}
                (runs[name] / f"{rec['question_id']}.json").write_text(json.dumps(out, ensure_ascii=False),
                                                                     encoding="utf-8")
    summary = {"questions": len(saved), "base_same_as_saved": base_same, "top10_order_changed": top10_changed,
               "seconds": round(time.time() - started, 1)}
    (a.out / "replay-summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    print(json.dumps(summary))
    if base_same != len(saved):
        sys.exit(f"gate FAIL: base reproduced {base_same} of {len(saved)} saved files")


if __name__ == "__main__":
    main()
```

</details>
