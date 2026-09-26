"""Bad-memory labels: CORRECTS judge labels + superseded_by chains.

One bad record per older memory: bad_from = earliest correction's newer.created,
fix_id = that correction's newer id. A memory with several corrections only
uses the earliest one (it went bad once; later corrections don't un-bad it).
"""
import json
from datetime import datetime, timezone

DAY = 86400.0


def _epoch_days(iso: str) -> float:
    if iso.endswith("Z"):
        iso = iso[:-1] + "+00:00"
    return datetime.fromisoformat(iso).replace(tzinfo=timezone.utc).timestamp() / DAY


def load_bad_map(store: str, judge_pairs_path: str, labels_path: str, superseded_path: str):
    labels = {}
    for line in open(labels_path, encoding="utf-8"):
        d = json.loads(line)
        labels[d["idx"]] = d["label"]
    jp = [json.loads(l) for l in open(judge_pairs_path, encoding="utf-8")]

    bad: dict[str, dict] = {}

    def consider(older_id, newer_id, newer_created_epoch):
        cur = bad.get(older_id)
        if cur is None or newer_created_epoch < cur["bad_from"]:
            bad[older_id] = {"fix_id": newer_id, "bad_from": newer_created_epoch}

    for i, r in enumerate(jp):
        if r["store"] != store:
            continue
        if labels.get(i) != "CORRECTS":
            continue
        consider(r["older_id"], r["newer_id"], _epoch_days(r["newer_created"]))

    for line in open(superseded_path, encoding="utf-8"):
        r = json.loads(line)
        if r["store"] != store:
            continue
        consider(r["older_id"], r["newer_id"], _epoch_days(r["newer_created"]))

    return bad
