# Physics Engine Soak Test (O1 evidence)

Tests that the hippo memory-as-physics engine stays energy-bounded under 10
distinct workload profiles. Used as O1 evidence for the Frontier AI Discovery
feasibility study (convergence proofs).

## Run

```bash
# Single profile, quick validation
node scripts/soak-test.mjs --profile balanced --ticks 100 --particles 80 --out results/soak-balanced.csv

# Full 10-profile sweep (produces markdown summary)
node scripts/soak-all.mjs --ticks 100 --particles 80 --out benchmarks/soak/results/

# Long soak — change --ticks for longer runtimes
node scripts/soak-all.mjs --ticks 1000 --particles 200 --out benchmarks/soak/results/
```

Each tick advances Velocity Verlet integration by `config.substeps` steps (5
by default), applies the profile's workload mutation (add/remove particles,
flip charges, etc.), and logs energy + velocity stats.

## Workload profiles

| Profile | What it does | Why it matters |
|---|---|---|
| balanced | Mild churn, some adds/removes, occasional conflicts | Default "normal use" |
| write-heavy | 2 adds/tick (capped at 500), minimal removes | Stress growth |
| read-heavy | No adds, bumps mass via simulated retrievals | Stress strengthening path |
| burst | Silent 19 ticks, then 20-add burst, repeat | Tests integrator under sudden load |
| dedup-heavy | New particles cluster around 5 fixed centers | Tests tight clustering dynamics |
| conflict-heavy | 25% of additions spawn a conflict pair | Tests repulsion force stability |
| decay-only | No new writes — does initial population settle? | Fixed point test |
| reward-modulated | Charge + mass flip per tick (outcome feedback) | Tests charge-driven potential |
| consolidation-heavy | 8 idle ticks + 2 prune ticks per 10-tick cycle | Tests non-stationary population |
| steady-state | Constant add+remove at N=starting | Tests stationary dynamics |

## Boundedness criteria

A profile is BOUNDED if:
- Final total energy is finite.
- Max per-particle velocity ≤ `10 × config.max_velocity` (10× the soft cap).

Runaway divergence manifests as infinite energy or velocity blowing past the
cap; both are early-exit conditions.

## Results (2026-04-21)

See `results/soak-summary.md` for the current sweep. At 100 ticks, 80 starting
particles, seed 42: **10 of 10 profiles bounded.**

## Files

- `scripts/soak-test.mjs` — single-profile runner, emits CSV.
- `scripts/soak-all.mjs` — 10-profile sweep + summary markdown.
- `results/soak-*.csv` — per-tick trajectories (tick, particles, KE, PE, total E, avg/max v).
- `results/soak-summary.md` — human-readable summary.

## Intent

These are *empirical* convergence checks. The Frontier AI grant's O1
deliverable also promises a Lyapunov-style formal analysis of the dynamics —
that's separate work, planned for the grant period proper. This harness
provides the evidence side of the convergence claim and catches regressions
in the integrator or force model if they are introduced later.
