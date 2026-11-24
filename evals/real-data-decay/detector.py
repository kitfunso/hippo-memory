import re

CORRECTION_RE = re.compile(
    r"correct(ed|ion)|no longer|(was|is) wrong|instead of|reverted|replaced|"
    r"(back )?in scope again|changed to",
    re.IGNORECASE,
)


def build_detector_index(candidates: list[dict]) -> dict[str, list[tuple[str, float]]]:
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
