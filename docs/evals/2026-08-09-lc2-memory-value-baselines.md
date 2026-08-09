# LC2-E1 baseline results: memory-value retention on LongMemEval-S (cleaned)

Date: 2026-08-09. Pre-registration: `2026-08-09-lc2-memory-value-prereg.md` (protocol locked before this run).
Episode: 01KZHN3SM9A92V1WE23YQ76HZE. Reproduce: `node benchmarks/memory-value/run.mjs --data <path-to>/longmemeval_s_cleaned.json` (seed 42 pinned in config).

## Run facts

- Registered substrate executed in full: 500/500 questions, gold mode `evidence-turn` for all 500 (`has_answer` flags present everywhere).
- Wallclock 77.1 min (ingest 43.5 min, simulate 33.5 min, extract 5.6 s, evaluate 2.2 s) — within 2% of the 3-question extrapolation and under the pre-registered 3 h cap.
- Variance gate: **passed, 8/30** features vary dataset-wide (`age_days, half_life_days, strength, retrieval_count, outcome_positive, outcome_negative, outcome_ratio, content_length`); the 22 dead dims match the pre-reg's structurally-constant list exactly.
- Zero-gold questions skipped from means: 11 train, 10 heldout (LongMemEval abstention-class questions; recorded per question in the results JSON).
- Split: 289 train / 190 heldout questions included at budget 0.3 (seed-42 stratified 60/40 of 500, minus zero-gold).
- Results: `benchmarks/memory-value/results/latest.json` (+ timestamped copy); per-question paired records at budget 0.3 for every scorer (the E2 bootstrap input).

## Headline numbers (mean gold-evidence retention @ keep budget 0.30)

| scorer | train | heldout |
|---|---|---|
| **best single factor: `age_days__neg` (= recency)** | 0.3734 | **0.4203** |
| `strength__pos` (hippo's hand-set composite) | — | 0.3589 |
| usage single factors (`retrieval_count`, `outcome_*`, either sign) | — | 0.32–0.33 |
| uniform (1/K oriented equal weights) | 0.2416 | 0.2635 |

Chance floor at budget 0.30 ≈ 0.30 (random keep).

## Interpretation (descriptive, per pre-reg framing)

1. **The substrate carries fittable signal.** Clear separation: recency 0.42 > strength 0.36 > chance 0.30 > uniform 0.26 on held-out. The falsification condition in the pre-reg (all scorers ≈ chance / ceiling) did NOT occur; E2 proceeds.
2. **Uniform equal-weighting is actively harmful** (below chance): summing 5 noise features with 3 informative ones drowns the informative ones. This inverts the paper's ordering (paper: uniform 0.657 > recency 0.368) — expected, since the paper's factor set and corpus differ. The E2 bars are relative to OUR baselines, not the paper's.
3. **Usage features are chance-level, by design.** The anti-oracle uniform query sampling predicted near-zero gold signal for `retrieval_count`/`outcome_*`; measured 0.32–0.33 confirms it. Their real test remains LC3 on dogfood usage.
4. **hippo's hand-set `strength` formula beats chance but loses to pure recency** on this substrate (0.3589 vs 0.4203) — a concrete, measured gap the E2 learned weights have to close and exceed.

## What E2 must now do (bars unchanged from pre-reg)

On held-out at budget 0.30: learned weights > uniform (0.2635) AND > best single factor (0.4203), paired per-question bootstrap 95% CI (1000 resamples, seed 42) on the difference excluding 0. The operative bar is 0.4203 — beating recency is the whole game. Fitting uses train only (recency 0.3734 there); held-out is evaluated once, after the fitter freezes.
