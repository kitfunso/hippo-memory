"""bad@5, fix@5, old-good-kept, and a cluster bootstrap CI over bad memories.

A "cluster" is one bad memory: every query hit that memory produced is
resampled together, since those hits are not independent draws (they're
all testing the same correction).
"""
import random


def bootstrap_ci(cluster_hits: dict[str, list[int]], draws: int = 2000, seed: int = 20260924):
    """cluster_hits: bad_memory_id -> [0/1, 0/1, ...] one entry per in-play
    query for that memory. Returns (point_estimate, lo95, hi95)."""
    clusters = [c for c in cluster_hits.values() if c]
    all_hits = [h for c in clusters for h in c]
    if not all_hits:
        return 0.0, 0.0, 0.0
    point = sum(all_hits) / len(all_hits)
    if not clusters:
        return point, point, point
    rng = random.Random(seed)
    shares = []
    n = len(clusters)
    for _ in range(draws):
        sample = [clusters[rng.randrange(n)] for _ in range(n)]
        flat = [h for c in sample for h in c]
        if flat:
            shares.append(sum(flat) / len(flat))
    shares.sort()
    lo = shares[int(0.025 * len(shares))]
    hi = shares[min(len(shares) - 1, int(0.975 * len(shares)))]
    return point, lo, hi
