# LC2-E1 baseline results: memory-value retention on LongMemEval-S (cleaned)

Date: 2026-08-09 (v4, registered — regenerated after the final determinism closure: stable (score, provenance) re-sort of search results in simulate.mjs, removing the last dependence on production id-based tie-order, proven on the codex repro question gpt4_6dc9b45b. Supersedes the same-day v1/v2/v3 runs; see the pre-reg amendment records).
Pre-registration: `2026-08-09-lc2-memory-value-prereg.md` (protocol + both amendments locked before this run).
Episode: 01KZHN3SM9A92V1WE23YQ76HZE. Reproduce: `node benchmarks/memory-value/run.mjs --data <path-to>/longmemeval_s_cleaned.json` (seed 42; cross-ingest determinism and the causal clock clamp are test-enforced in `tests/memory-value-harness.test.ts`, 17 tests).

## Run facts (v4, registered)

- Registered substrate executed in full: 500/500 questions, gold mode `evidence-turn` for all 500 (`has_answer` flags present everywhere).
- Wallclock 81.2 min (ingest 44.9 min, simulate 36.1 min, extract 6.0 s, evaluate 1.9 s) — under the pre-registered 3 h cap.
- v4-vs-v3 note: every reported summary cell is IDENTICAL to v3 at 4 decimal places — the tie-order fix changed per-question tie outcomes on duplicate-content questions without moving any aggregate, while making the whole pipeline provably cross-ingest deterministic (test-enforced, including a full-30-round proof on the codex repro question).
- Causal clock: evaluation at T_eval(q) = max(question_date, latest haystack_date) — the 76 questions with post-question_date sessions are clamped; age_days >= 0 for every extracted row by construction (amendment 2).
- Variance gate: **passed, 8/30** features vary within at least one store (the stricter within-store liveness definition from the review round): `age_days, half_life_days, strength, retrieval_count, outcome_positive, outcome_negative, outcome_ratio, content_length`. The 22 dead dims match the pre-reg's structurally-constant list exactly.
- Zero-gold questions skipped from means: 11 train, 10 heldout (LongMemEval abstention-class questions).
- Split: 289 train / 190 heldout questions included at budget 0.3 (seed-42 stratified 60/40 of 500, minus zero-gold).
- Results: committed slim evidence `benchmarks/memory-value/results-latest.json` (summary, variance detail, gate, per-question bookkeeping, paired records for the four E2-bar scorers); the full per-scorer JSON is local-only (gitignored) and regenerates deterministically from the command above.

## Headline numbers (mean gold-evidence retention @ keep budget 0.30, v4)

| scorer | train | heldout |
|---|---|---|
| **best single factor: `age_days__neg` (= recency)** | 0.3862 | **0.4203** |
| `strength__pos` (hippo's hand-set composite) | — | 0.3049 |
| usage single factors (`retrieval_count`, `outcome_*`, either sign) | — | ~0.31 |
| uniform (1/K oriented equal weights) | 0.2426 | 0.2468 |

Chance floor at budget 0.30 ≈ 0.30 (random keep).

Cross-version stability note: held-out recency was 0.4203 in v1, v2 AND v3 — the bar is insensitive to both review-round mechanics changes (recency depends only on session-date ordering, which none of the fixes altered). Strength (0.3589 → 0.3172 → 0.3049) and uniform (0.2635 → 0.2398 → 0.2468) moved with the simulation-sampling and clock fixes, which is exactly why those defects had to be fixed before E2 could fit against these numbers.

## Interpretation (descriptive, per pre-reg framing)

1. **The substrate carries fittable signal.** Clear separation on held-out: recency 0.42 > strength 0.30 ≈ usage ≈ chance 0.30 > uniform 0.25. The pre-reg falsification condition (all scorers ≈ chance/ceiling) did NOT occur; E2 proceeds.
2. **Uniform equal-weighting is actively harmful** (below chance): summing noise features with informative ones drowns the informative ones. This inverts the paper's ordering (paper: uniform 0.657 > recency 0.368) — expected, since the paper's factor set and corpus differ. The E2 bars are relative to OUR baselines, not the paper's.
3. **Usage features are chance-level, by design.** The anti-oracle uniform query sampling predicted near-zero gold signal for `retrieval_count`/`outcome_*`; measured ~0.31 confirms it. Their real test remains LC3 on dogfood usage.
4. **hippo's hand-set `strength` formula is indistinguishable from chance on this substrate** (0.3049 vs chance 0.30, vs recency 0.4203) — a concrete, measured gap the E2 learned weights have to close and exceed.

## What E2 must now do (bars unchanged from pre-reg)

On held-out at budget 0.30: learned weights > uniform (0.2468) AND > best single factor (0.4203), paired per-question bootstrap 95% CI (1000 resamples, seed 42) on the difference excluding 0. The operative bar is 0.4203 — beating recency is the whole game. Fitting uses train only (recency 0.3862 there); held-out is evaluated once, after the fitter freezes.
