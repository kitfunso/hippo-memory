# LC2-E1 baseline results: memory-value retention on LongMemEval-S (cleaned)

Date: 2026-08-09 (v2 — regenerated under the amended mechanics; supersedes the same-day v1 run whose sampling/tie-break keyed on per-ingest random memory ids, see the pre-reg amendment).
Pre-registration: `2026-08-09-lc2-memory-value-prereg.md` (protocol + amendment locked before this run).
Episode: 01KZHN3SM9A92V1WE23YQ76HZE. Reproduce: `node benchmarks/memory-value/run.mjs --data <path-to>/longmemeval_s_cleaned.json` (seed 42; cross-ingest determinism is test-enforced in `tests/memory-value-harness.test.ts`).

## Run facts (v2, registered)

- Registered substrate executed in full: 500/500 questions, gold mode `evidence-turn` for all 500 (`has_answer` flags present everywhere).
- Wallclock 77.3 min (ingest 42.9 min, simulate 34.4 min, extract 5.7 s, evaluate 1.9 s) — under the pre-registered 3 h cap.
- Variance gate: **passed, 8/30** features vary dataset-wide (`age_days, half_life_days, strength, retrieval_count, outcome_positive, outcome_negative, outcome_ratio, content_length`); the 22 dead dims match the pre-reg's structurally-constant list exactly.
- Zero-gold questions skipped from means: 11 train, 10 heldout (LongMemEval abstention-class questions; recorded per question in the results JSON).
- Split: 289 train / 190 heldout questions included at budget 0.3 (seed-42 stratified 60/40 of 500, minus zero-gold).
- Results: committed slim evidence `benchmarks/memory-value/results-latest.json` (summary, variance detail, gate, per-question bookkeeping, and paired records for the four E2-bar scorers: uniform, recency, age_days__neg, strength__pos); the full per-scorer JSON is local-only (gitignored) and regenerates deterministically from the command above.

## Headline numbers (mean gold-evidence retention @ keep budget 0.30, v2)

| scorer | train | heldout |
|---|---|---|
| **best single factor: `age_days__neg` (= recency)** | 0.3862 | **0.4203** |
| `strength__pos` (hippo's hand-set composite) | — | 0.3172 |
| usage single factors (`retrieval_count`, `outcome_*`, either sign) | — | ~0.31 |
| uniform (1/K oriented equal weights) | 0.2426 | 0.2398 |

Chance floor at budget 0.30 ≈ 0.30 (random keep).

v1-vs-v2 note (honest drift record): heldout recency was 0.4203 in both runs (pure-age scoring, insensitive to the mechanics change at this granularity); heldout strength moved 0.3589 → 0.3172 and uniform 0.2635 → 0.2398 because the stable-provenance sampling changed which turns the simulation exercised. This drift is exactly the non-reproducibility the codex review caught; from v2 onward the numbers are cross-ingest deterministic (test-enforced).

## Interpretation (descriptive, per pre-reg framing)

1. **The substrate carries fittable signal.** Clear separation on held-out: recency 0.42 > strength 0.32 ≈ usage ≈ chance 0.30 > uniform 0.24. The pre-reg falsification condition (all scorers ≈ chance/ceiling) did NOT occur; E2 proceeds.
2. **Uniform equal-weighting is actively harmful** (below chance): summing noise features with informative ones drowns the informative ones. This inverts the paper's ordering (paper: uniform 0.657 > recency 0.368) — expected, since the paper's factor set and corpus differ. The E2 bars are relative to OUR baselines, not the paper's.
3. **Usage features are chance-level, by design.** The anti-oracle uniform query sampling predicted near-zero gold signal for `retrieval_count`/`outcome_*`; measured ~0.31 confirms it. Their real test remains LC3 on dogfood usage.
4. **hippo's hand-set `strength` formula sits at roughly chance-plus-noise on this substrate** (0.3172 vs chance 0.30, vs recency 0.4203) — a concrete, measured gap the E2 learned weights have to close and exceed.

## What E2 must now do (bars unchanged from pre-reg)

On held-out at budget 0.30: learned weights > uniform (0.2398) AND > best single factor (0.4203), paired per-question bootstrap 95% CI (1000 resamples, seed 42) on the difference excluding 0. The operative bar is 0.4203 — beating recency is the whole game. Fitting uses train only (recency 0.3862 there); held-out is evaluated once, after the fitter freezes.
