"""evidence_recall.py and smoke_excluded.json: the interval over store-owning units, Bonferroni levels, and the smoke
items of dated notes 1."""
from __future__ import annotations

import json
import random
import re

import pytest
from conftest import PUBLIC

from evidence_recall import bonferroni, boot, cluster_boot, tails

_RNG = random.Random(3)
DIFFS = [_RNG.choice((-1.0, 0.0, 0.0, 1.0)) for _ in range(37)]


def old_boot(diffs: list[float], draws: int = 4000) -> tuple[float, float, float]:
    """boot as it was before it took a level, to pin that 95% intervals did not move."""
    random.seed(1)
    n = len(diffs)
    means = sorted(sum(random.choice(diffs) for _ in range(n)) / n for _ in range(draws))
    return sum(diffs) / n, means[int(0.025 * draws)], means[int(0.975 * draws) - 1]


def test_boot_at_95_is_unchanged():
    assert boot(DIFFS) == old_boot(DIFFS)


@pytest.mark.parametrize("level", [0.95, bonferroni(4), bonferroni(9)])
def test_cluster_boot_equals_boot_with_one_item_per_unit(level):
    assert cluster_boot({f"q{i}": [d] for i, d in enumerate(DIFFS)}, level=level) == boot(DIFFS, level=level)


def test_bonferroni_level_and_its_tail_indices():
    assert bonferroni(1) == pytest.approx(0.95) and bonferroni(4) == pytest.approx(0.9875)
    assert tails(0.95, 4000) == (100, 3899)
    assert tails(bonferroni(4), 4000) == (25, 3974)  # unrounded, (1 - level) / 2 * 4000 gives 24.99... and index 24


def test_a_bonferroni_interval_holds_the_95_one():
    _, lo, hi = boot(DIFFS)
    _, blo, bhi = boot(DIFFS, level=bonferroni(4))
    assert blo <= lo and bhi >= hi and (blo, bhi) != (lo, hi)


def test_cluster_boot_resamples_whole_units():
    by_unit = {"a": [1.0, 1.0, 1.0], "b": [-1.0], "c": [0.0, 0.0]}
    d, lo, hi = cluster_boot(by_unit)
    assert d == pytest.approx(2 / 6) and lo >= -1 and hi <= 1  # weighted by item, not by unit


def test_smoke_file_holds_exactly_the_ids_the_prereg_registers():
    doc = (PUBLIC.parents[1] / "docs" / "evals" / "2026-09-24-public-benchmarks-prereg.md").read_text(encoding="utf-8")
    # the list is the first sentence after the label: "none. The M smokes (`id`...)" registers no exclusion
    lists = [re.findall(r"`([^`]+)`", line.split("Smoke items, excluded:", 1)[1].split(". ", 1)[0])
             for line in doc.splitlines() if "Smoke items, excluded:" in line]
    table = json.loads((PUBLIC / "smoke_excluded.json").read_text(encoding="utf-8"))
    assert sorted(tuple(ids) for ids in lists if ids) == sorted(tuple(ids) for ids in table.values() if ids)
