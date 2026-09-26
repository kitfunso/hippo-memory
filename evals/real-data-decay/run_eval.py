"""Real-data decay replay: run all five arms and print the numbers.

Scope decision (recorded in the result doc): every query is scored against
the GLOBAL store (~/.hippo/hippo.db, 2208 memories). Queries carry
no reliable per-project store attribution (human_prompts.jsonl's `project`
field is blank for all 1969 rows; the 82 hippo-recall queries were all
issued from sessions rooted at the home directory, i.e. the global store
anyway) so cross-store scoring would be a guess, not a measurement.
"""
import json
import os
import sys
import sqlite3
from datetime import datetime, timezone

sys.path.insert(0, __file__.rsplit("/", 1)[0] if "/" in __file__ else ".")

from bm25 import BM25Store, tokenize
from detector import build_detector_index
from labels import load_bad_map
from arms import apply_b0, apply_decay_arm, apply_ad, apply_placebo
from metrics import bootstrap_ci

SCRATCH = os.environ["DECAY_REPLAY_DIR"]  # holds stores/, the query files and judge_pairs.jsonl
STORE_NAME = os.environ.get("DECAY_REPLAY_STORE", "global")
STORE_DB = f"{SCRATCH}/stores/{STORE_NAME}.db"
DAY = 86400.0


def parse_epoch_days(iso: str) -> float:
    if iso.endswith("Z"):
        iso = iso[:-1] + "+00:00"
    return datetime.fromisoformat(iso).replace(tzinfo=timezone.utc).timestamp() / DAY


def load_store_memories():
    c = sqlite3.connect(f"file:{STORE_DB}?mode=ro", uri=True)
    rows = c.execute("select id, created, content, pinned from memories").fetchall()
    c.close()
    docs = []
    created_map = {}
    pinned_map = {}
    for mid, created, content, pinned in rows:
        t = parse_epoch_days(created)
        docs.append((mid, t, content or ""))
        created_map[mid] = t
        pinned_map[mid] = bool(pinned)
    return docs, created_map, pinned_map


def load_queries():
    out = []
    for line in open(SCRATCH + "/../corrections/human_prompts.jsonl", encoding="utf-8"):
        d = json.loads(line)
        out.append({"text": d["text"], "t": parse_epoch_days(d["timestamp"]), "source": "human_prompt"})
    for line in open(SCRATCH + "/hippo_recall_queries.jsonl", encoding="utf-8"):
        d = json.loads(line)
        out.append({"text": d["text"], "t": parse_epoch_days(d["timestamp"]), "source": "hippo_recall"})
    return out


def load_pairs_with_epoch(path):
    rows = [json.loads(l) for l in open(path, encoding="utf-8")]
    for r in rows:
        r["_newer_created_epoch"] = parse_epoch_days(r["newer_created"])
        r["_older_created_epoch"] = parse_epoch_days(r["older_created"])
    return rows


def topn(scores: dict, n: int):
    items = [(s, doc_id) for doc_id, s in scores.items() if s > 0]
    items.sort(key=lambda x: (-x[0], x[1]))
    return [doc_id for _, doc_id in items[:n]]


def main():
    docs, created_map, pinned_map = load_store_memories()
    store = BM25Store(docs)
    queries = load_queries()

    candidates = load_pairs_with_epoch(SCRATCH + "/candidates.jsonl")
    candidates = [c for c in candidates if c["store"] == STORE_NAME]
    detector_idx = build_detector_index(candidates)

    bad_map = load_bad_map(
        STORE_NAME,
        SCRATCH + "/judge_pairs.jsonl",
        SCRATCH + "/labels.jsonl",
        SCRATCH + "/superseded_pairs.jsonl",
    )
    print(f"bad memories in {STORE_NAME}: {len(bad_map)}")

    arms = ["B0", "D365", "D7", "AD", "PL"]
    bad_hits = {a: {} for a in arms}     # arm -> bad_id -> [0/1,...]
    fix_hits = {a: {} for a in arms}     # arm -> bad_id -> [0/1,...] (only where fix exists at t)
    old_good_sum = {a: 0 for a in arms}  # sum of old-good slot counts across all queries
    n_scored_queries = 0
    n_inplay_queries = 0
    inplay_bad_ids = set()

    for q in queries:
        t = q["t"]
        toks = tokenize(q["text"])
        if not toks:
            continue
        bm25 = store.score(toks, t)
        if not bm25:
            continue
        n_scored_queries += 1

        b0_scores = apply_b0(bm25)
        d365_scores = apply_decay_arm(bm25, created_map, t, 365.0)
        d7_scores = apply_decay_arm(bm25, created_map, t, 7.0)
        ad_scores, fired = apply_ad(bm25, created_map, t, detector_idx)
        pl_scores = apply_placebo(bm25, created_map, t, len(fired), seed=hash(q["text"]) & 0xFFFFFFFF)

        top5 = {
            "B0": set(topn(b0_scores, 5)),
            "D365": set(topn(d365_scores, 5)),
            "D7": set(topn(d7_scores, 5)),
            "AD": set(topn(ad_scores, 5)),
            "PL": set(topn(pl_scores, 5)),
        }
        top20_b0 = set(topn(b0_scores, 20))

        # in-play bad memories for this query
        query_inplay = [
            bid for bid, rec in bad_map.items()
            if rec["bad_from"] <= t and bid in bm25 and bid in top20_b0
        ]
        if query_inplay:
            n_inplay_queries += 1
        for bid in query_inplay:
            inplay_bad_ids.add(bid)
            rec = bad_map[bid]
            for arm in arms:
                bad_hits[arm].setdefault(bid, []).append(1 if bid in top5[arm] else 0)
            fix_id = rec["fix_id"]
            fix_exists = fix_id in created_map and created_map[fix_id] <= t
            if fix_exists:
                for arm in arms:
                    fix_hits[arm].setdefault(bid, []).append(1 if fix_id in top5[arm] else 0)

        # old-good kept: unlabeled memories, age>=30d, in each arm's top5
        for arm in arms:
            n = 0
            for did in top5[arm]:
                if did in bad_map:
                    continue
                age = t - created_map.get(did, t)
                if age >= 30:
                    n += 1
            old_good_sum[arm] += n

    print(f"scored queries (nonzero BM25): {n_scored_queries} of {len(queries)}")
    print(f"in-play queries: {n_inplay_queries}")
    print(f"distinct in-play bad memories: {len(inplay_bad_ids)}")

    results = {"n_scored_queries": n_scored_queries, "n_inplay_queries": n_inplay_queries,
               "distinct_inplay_bad": len(inplay_bad_ids), "arms": {}}

    b0_old_good = old_good_sum["B0"] or 1
    for arm in arms:
        bad_pt, bad_lo, bad_hi = bootstrap_ci(bad_hits[arm])
        fix_pt, fix_lo, fix_hi = bootstrap_ci(fix_hits[arm])
        old_good_share = old_good_sum[arm] / b0_old_good * 100
        results["arms"][arm] = {
            "bad@5": {"point": bad_pt, "lo": bad_lo, "hi": bad_hi, "n_clusters": len(bad_hits[arm])},
            "fix@5": {"point": fix_pt, "lo": fix_lo, "hi": fix_hi, "n_clusters": len(fix_hits[arm])},
            "old_good_kept_pct_of_B0": old_good_share,
        }
        print(f"{arm}: bad@5={bad_pt:.3f} [{bad_lo:.3f},{bad_hi:.3f}]  "
              f"fix@5={fix_pt:.3f} [{fix_lo:.3f},{fix_hi:.3f}]  "
              f"old-good kept={old_good_share:.1f}% of B0")

    # census
    days_to_fix = []
    never_fixed = 0
    pinned_bad = 0
    for bid, rec in bad_map.items():
        if pinned_map.get(bid):
            pinned_bad += 1
        created = created_map.get(bid)
        if created is not None:
            days_to_fix.append(rec["bad_from"] - created)
        if rec["fix_id"] not in created_map:
            never_fixed += 1
    results["census"] = {
        "bad_memories_total": len(bad_map),
        "pinned_bad": pinned_bad,
        "days_to_fix_mean": (sum(days_to_fix) / len(days_to_fix)) if days_to_fix else None,
        "never_fixed": never_fixed,
    }
    print("census:", results["census"])

    json.dump(results, open(SCRATCH + "/eval_results.json", "w"), indent=2)
    print("wrote", SCRATCH + "/eval_results.json")


if __name__ == "__main__":
    main()
