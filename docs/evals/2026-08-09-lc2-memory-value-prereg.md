# Pre-registration: LC2 memory-value eval protocol + E2 acceptance bars

Date locked: 2026-08-09
Episode: 01KZHN3SM9A92V1WE23YQ76HZE (LC2-E1)
Plan: `docs/plans/2026-08-09-lc2-e1-memory-value-eval-substrate.md`
Paper being replicated: arXiv 2606.12945 (learned linear memory value on LongMemEval, gradient-free fit, fixed keep budget, blind features)

## RETRACTION.md compliance

Per the binding rule in `docs/RETRACTION.md`, this pre-commitment locks only after:

1. **Source-read of the depended-on code paths** — done during the episode's discover/execute stages: `src/memory.ts` (MemoryEntry, `calculateStrength`, `applyOutcome`, `deriveHalfLife`), `src/search.ts` usage via `hybridSearch`/`markRetrieved` (the same primitives `cmdRecall` at `src/cli.ts:1800` and the api outcome path at `src/api.ts:1635` call), `src/ablation.ts` (`HIPPO_FAKE_NOW` read-once cache — handled by the single-owner `setFakeNow` in `benchmarks/memory-value/common.mjs`), `src/store.ts` (`writeEntry`, `loadAllEntries`). The lifecycle-stress finding that stored `strength` writes are ranking-inert (`docs/evals/2026-06-09-lifecycle-stress-eval-result.md`) shaped the extractor: strength is DERIVED via `calculateStrength` at extraction time, never read from the stored column.
2. **Mechanism dry-run confirming it fires** — a real-data 3-question run through the complete mechanism (ingest → simulate → extract → evaluate), evidence in `benchmarks/memory-value/results/dryrun-3q.txt` (per-stage timings: ingest 15.1s, simulate 12.1s, extract 34ms, evaluate 18ms). The smoke path (`run.mjs --smoke`, 12 synthetic questions, both gold modes) runs in CI-able time (35.2s) and is covered by `tests/memory-value-harness.test.ts` (10/10 after the execute-stage fix round).

## Locked protocol

Single source of truth: `benchmarks/memory-value/config.mjs` (frozen object; the numbers below are quotes, the file is normative).

- Global seed **42**; zero `Math.random`/wall-clock dependence anywhere in the harness.
- Split: question-level, stratified by `question_type`, **60/40 train/held-out** over all questions; largest-remainder apportionment; emitted to `split.json`.
- **Registered substrate: the full 500 questions** of `longmemeval_s_cleaned.json` (sha-stable copy in the main checkout's `benchmarks/longmemeval/data/`). Decision made by the pre-registered wallclock-only rule (extrapolated full-500 ≈ 76 min < 3h cap, from the 3q dry-run) BEFORE any full-run retention number existed.
- Keep budgets 0.1 / 0.2 / **0.3 (primary)** / 0.5; only 0.3 carries bars and per-question paired records; the rest are descriptive.
- Gold: **evidence-turn mode** — `has_answer === true` turns inside `answer_session_ids` sessions (verified present for all 500 questions of the cleaned dataset; per-question auto-detect with the documented all-answer-session-turns fallback for datasets without flags).
- Features: the 30-dim blind vector enumerated in `config.mjs` `FEATURES` (lifecycle scalars + one-hots for valence/layer/kind/confidence). Excluded by construction: `bm25_score` and anything query-derived. `schema_fit` is computed at ingest via the production write-time path (`computeSchemaFit(text, tags, store-so-far)`, mirroring `src/cli.ts:740`) — and is nonetheless empirically inert here: the function's own guard (`src/memory.ts:568`) returns neutral 0.5 whenever the new memory has no tags AND no existing entry carries tags, which is this substrate's permanent state. The wiring is real, the constancy is the function's honest output, and a replay test (`tests/memory-value-harness.test.ts`) locks stored values to independent recomputation.
- **Structurally constant dims on this substrate (documented, not hidden)**: fresh untagged chat-turn ingest genuinely cannot vary schema_fit (guard above), valence (tag-inferred, `src/memory.ts:497`), layer, kind, confidence, pinned, starred, or dag_level. The varying set on real data is exactly 8: `age_days, half_life_days, strength, retrieval_count, outcome_positive, outcome_negative, outcome_ratio, content_length` (measured on the 3-question dry-run; the runtime gate re-verifies on every real run). These dims STAY in the canonical vector (min–max normalization maps a constant dim to 0, provably inert for the uniform and weighted scorers) and would vary on dogfood/consolidated stores. Their single-factor rows are reported as degenerate (tie-break-only), never mixed into "best single factor". A runtime variance gate hard-fails any real run with fewer than **6** features showing non-zero dataset-wide variance post-simulation.
- Normalization: min–max per store; constant feature (min == max) → 0.
- Sign orientation: keep-positive default; negated: `age_days`, `outcome_negative`. `error_tag` deliberately NOT negated (`deriveHalfLife` doubles error-tag half-life: errors are lessons). Single-factor baselines run BOTH signs regardless, so orientation cannot hide an inverted factor.
- Scorers: uniform (1/K over oriented normalized vector), every single factor ±, recency (−age), and the `--weights <file>` hook reserved for E2.
- Keep set: top ceil(budget·N) under (score DESC, sessionIndex ASC, turnIdx ASC, memory_id ASC as final fallback), stable, identical for all scorers; cutoff-boundary score pairs recorded full-precision.
- **Amendment (2026-08-09, review-stage, pre-E2)**: the tie-break was originally registered as (score DESC, memory_id ASC), and simulation sampling indexed a memory-id-sorted array. The codex cross-model review found memory ids are crypto-random per ingest, so both were reproducible only WITHIN one ingest — violating this document's own determinism claim. Both now key on stable turn provenance (sessionIndex, turnIdx), and the run seed is mixed into the simulation RNG. The registered full-500 run is REGENERATED under the amended mechanics; the earlier run's numbers are superseded. No E2 fitting had occurred at amendment time and the E2 bars are relative to the regenerated baselines, so no bar is weakened by this change.
- Clock: ingest per session at `HIPPO_FAKE_NOW` = session `haystack_date`; ALL simulation rounds and extraction at `HIPPO_FAKE_NOW` = **T_eval(q) = max(question_date, latest haystack_date of q)**. Temporal features are pure functions of dataset + seed, and age_days >= 0 by construction.
- **Amendment 2 (2026-08-09, review-stage round 2, pre-E2)**: the clock was originally registered as plain `question_date`. The codex cross-model review measured that 76/500 questions in the cleaned dataset carry haystack sessions dated AFTER `question_date`, giving 15,162 memories negative age at extraction — future memories outscored everything on recency and took inflated strength, a causally invalid evaluation state. T_eval clamps the evaluation clock to the latest ingested session, restoring causal validity for all 500 questions. The registered run is regenerated (v3) under this clock; v1/v2 numbers are superseded. No E2 fitting had occurred; bars stay relative to the v3 baselines.
- Usage simulation (training-environment definition): **30 rounds** per store, top-K **5**, query = seeded-uniform-sampled turn content from the store's OWN sessions truncated to **200 chars**, outcome negative on round r where r % 3 == 2, positive otherwise, applied to the same round's recalled ids through the production `markRetrieved`/`applyOutcome` write paths.

## Leakage rule (binding)

No eval-question or answer text may influence any feature, at any stage, on either split. Enforced by construction (simulate/extract never read `question`/`answer` fields) and by grep proof recorded at execute (zero `.answer` occurrences; `.question*` hits are `question_id`/`questionDate` only — the pre-registered clock input).

## Stated deviations and limitations (documentation obligations from execute-stage review)

1. The harness drives hippo through the production primitives (`createMemory`/`writeEntry`/`hybridSearch`/`markRetrieved`/`applyOutcome`) rather than the `api.ts` wrappers — identical persistence semantics, none of the global-root machinery.
2. Simulation retrieval is **BM25-only** (embedding branch never activates: no `hippoRoot` passed). Deterministic and hermetic; it does NOT claim to replicate production hybrid retrieval. The simulation defines the training environment, nothing more.
3. Under the pinned clock, `last_retrieved` is effectively binary (retrieved-at-question-date vs never); `retrieval_count` carries the usage gradation.
4. Anti-oracle consequence, stated up front: usage features (retrieval/outcome counters) may carry near-zero gold signal on this substrate BY DESIGN (uniform sampling; a gold-biased simulator would manufacture a circular proxy). A fitter that zeroes them is an honest outcome. Their live test is LC3 on real dogfood usage.

## E2 acceptance bars (binding, judged in E2)

On the held-out split, at keep budget 0.30, on the registered substrate:

- **Bar 1:** learned weights' mean retention > uniform baseline retention, AND
- **Bar 2:** learned weights' mean retention > the best single-factor retention (either sign, taken over features with non-zero dataset-wide variance on the registered substrate — a degenerate constant-dim "factor" is tie-break noise, not a baseline),
- both with a paired per-question bootstrap 95% CI (**1000 resamples**, seed 42) on the difference excluding 0.

Paper reference points (context, not bars): learned 0.770, uniform 0.657, best single 0.518.

Fitting in E2 uses the TRAIN split only; held-out numbers are computed once, after the fitter is frozen. If the bars fail, E2 reports the null and the LC2 integration slice (E3) does not proceed on retention grounds.

## E3 gates (recorded now; executed in E3)

- Paired A/B via the `benchmarks/ab` methodology (fire-rate + Wilcoxon + sign test) on LoCoMo. **Naming resolution:** ROADMAP's phrase "tier-1 micro-eval fire-rate" refers to THIS harness — fire-rate is computed by `benchmarks/ab/run.py`, not by `benchmarks/micro/run.py` (pass-rate only).
- LongMemEval per-haystack R@5 non-regression vs the shipped pipeline.
- Cautionary precedent explicitly in scope: the C1 salience-gate LoCoMo regression (mean_score 0.139 → 0.020; do-not-re-enable).

## Falsification / null path

If E1 baselines show no separation (uniform ≈ best single factor ≈ recency within overlapping paired CIs, or retention at ceiling/floor for all scorers), the substrate carries no fittable signal and E2 is re-scoped or dropped. That outcome is a valid, cheap kill — the reason this eval ships before the fitter.
