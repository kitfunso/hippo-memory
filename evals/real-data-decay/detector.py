"""AD arm's cheap correction detector.

Regex fixed by the dry run on 2026-09-24: the prereg's literal 8-phrase list
missed the known dry-run pair ("correction:" is not "corrected", "is wrong"
is not "was wrong", "IN scope again" is not "back in scope"). Three phrases
were broadened to their natural variants; no new concepts were added. See
docs/evals/2026-09-24-real-data-decay-prereg.md, "Dry run" section, for the
before/after and why.
"""
import re

CORRECTION_RE = re.compile(
    r"correct(ed|ion)|no longer|(was|is) wrong|instead of|reverted|replaced|"
    r"(back )?in scope again|changed to",
    re.IGNORECASE,
)


def build_detector_index(candidates: list[dict]) -> dict[str, list[tuple[str, float]]]:
    """older_id -> [(newer_id, newer_created_epoch), ...] where jaccard>=0.25
    and the newer memory's text matches the correction regex. Uses the full
    candidate set (not just judged pairs): the detector is regex-only, it
    never sees the judge's labels."""
    idx: dict[str, list[tuple[str, float]]] = {}
    for c in candidates:
        if c["jaccard"] < 0.25:
            continue
        if not CORRECTION_RE.search(c["newer_content"] or ""):
            continue
        idx.setdefault(c["older_id"], []).append((c["newer_id"], c["_newer_created_epoch"]))
    return idx


def fires(older_id: str, t: float, idx: dict) -> bool:
    hits = idx.get(older_id)
    if not hits:
        return False
    return any(created <= t for _, created in hits)
