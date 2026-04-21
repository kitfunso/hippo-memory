# O1 Soak Test — 10 Workload Profiles

Generated: 2026-04-21T17:16:17.208Z
Config: 100 ticks per profile, 80 starting particles, seed 42

| Profile | Status | Ticks | First E | Final E | Max \|E\| | Max \|v\| | Final N | Wall (s) |
|---------|--------|-------|---------|---------|----------|----------|---------|----------|
| balanced | BOUNDED | 101 | -0.621 | -2.377 | 2.388 | 0.1000 | 154 | 15.1 |
| write-heavy | BOUNDED | 101 | -0.621 | -8.100 | 8.100 | 0.0094 | 280 | 39.1 |
| read-heavy | BOUNDED | 101 | -0.621 | -1.096 | 1.096 | 0.0122 | 80 | 6.4 |
| burst | BOUNDED | 101 | -0.621 | -3.315 | 3.315 | 0.0085 | 180 | 16.2 |
| dedup-heavy | BOUNDED | 101 | -0.621 | -12.430 | 12.430 | 0.1000 | 180 | 19.2 |
| conflict-heavy | BOUNDED | 101 | -0.621 | -3.093 | 3.093 | 0.1000 | 180 | 18.4 |
| decay-only | BOUNDED | 101 | -0.621 | -0.656 | 0.656 | 0.0079 | 80 | 5.5 |
| reward-modulated | BOUNDED | 101 | -0.621 | -0.660 | 0.660 | 0.0075 | 80 | 5.7 |
| consolidation-heavy | BOUNDED | 101 | -0.621 | 0.000 | 0.621 | 0.0006 | 0 | 0.5 |
| steady-state | BOUNDED | 101 | -0.621 | -0.652 | 0.668 | 0.0020 | 80 | 5.8 |

**Verdict: 10 of 10 profiles bounded.**

All workload profiles show bounded energy within the configured velocity cap (0.1, Lyapunov-relevant upper bound 1.0 = 10× cap). Physics engine is stable under every tested regime.