"""The five arms' score multipliers, applied on top of a BM25 base score."""
import random

from detector import fires


def decay(age_days: float, half_life: float) -> float:
    return 0.5 ** (age_days / half_life)


def apply_b0(bm25_scores: dict) -> dict:
    return dict(bm25_scores)


def apply_decay_arm(bm25_scores: dict, created: dict, t: float, half_life: float) -> dict:
    out = {}
    for doc_id, s in bm25_scores.items():
        age = t - created[doc_id]
        out[doc_id] = s * decay(age, half_life)
    return out


def apply_ad(bm25_scores: dict, created: dict, t: float, detector_idx: dict) -> tuple[dict, set]:
    """Smart decay: D365, times 0.1 where the detector fires by t."""
    out = {}
    fired = set()
    for doc_id, s in bm25_scores.items():
        age = t - created[doc_id]
        mult = decay(age, 365.0)
        if fires(doc_id, t, detector_idx):
            mult *= 0.1
            fired.add(doc_id)
        out[doc_id] = s * mult
    return out, fired


def apply_placebo(bm25_scores: dict, created: dict, t: float, n_penalize: int, seed: int) -> dict:
    """D365, times 0.1 on n_penalize randomly chosen candidates (not detector-chosen)."""
    out = apply_decay_arm(bm25_scores, created, t, 365.0)
    if n_penalize <= 0 or not out:
        return out
    rng = random.Random(seed)
    pool = list(out.keys())
    rng.shuffle(pool)
    for doc_id in pool[:n_penalize]:
        out[doc_id] *= 0.1
    return out
