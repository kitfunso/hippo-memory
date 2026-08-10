# LC2-E2 result: learned linear memory-value weights BEAT recency on held-out

**Status: BARS MET** (both pre-registered bars, first and only held-out run).
Date: 2026-08-10. Episode: 01KZNFYSCS1EFZY5HYFZGR8GB0.
Pre-registration: `2026-08-10-lc2-e2-fit-prereg.md` (LOCKED before the fit;
no amendments were needed).
Substrate: E1 v4 registered (`2026-08-09-lc2-memory-value-result.md`).
Reproduce: `node benchmarks/memory-value/fit.mjs` then
`node benchmarks/memory-value/fit.mjs --report` (deterministic; seed 42;
requires the E1 scratch features or a fresh E1 run to regenerate them).

## Headline (held-out, keep budget 0.30, 190 questions / 189 non-zero-gold)

| scorer | held-out retention |
|---|---|
| **learned (`weighted`, this episode)** | **0.4897** |
| recency (best single factor, the operative bar) | 0.4203 |
| uniform (1/K oriented) | 0.2468 |

Paired per-question bootstrap 95% CIs (1000 resamples, seed 42):

- learned − recency: **+0.0695**, CI [0.0166, 0.1265] — excludes 0. BAR MET.
- learned − uniform: **+0.2429**, CI [0.1748, 0.3122] — excludes 0. BAR MET.

`barsMet: true` in `results/fit-report-latest.json` (the machine-checked
conjunction: both point estimates higher AND both CI lower bounds > 0).

## Run facts

- Integrity gate: all 5 assertions passed pre-fit (split 300/200,
  `questionsIncluded` 289/190, baselines 0.4203/0.2468/0.3862 at 4dp,
  varying-features == the 8 fit dims, recency cross-check through the
  fitter's own objective path = 0.3862).
- Fit: 5 restarts, every restart terminated on sigma < 0.01 (generations
  37/46/53/56/52; 1,952 candidate evaluations total), ~29 min wallclock
  (under the 41-60 min projections; early sigma-termination cut ~19% of the
  candidate budget and the box was uncontended).
- Per-restart train objectives: 0.4971 / 0.4964 / 0.5087 / 0.4988 / 0.4995.
  Winner: restart 2 (train 0.5087). Restart-0 (recency-init) invariant held:
  0.4971 >= train recency 0.3862; in fact EVERY restart beat train recency,
  so the surface has a broad basin above the single-factor baseline, not one
  lucky seed.
- Train -> held-out generalization gap: 0.5087 -> 0.4897 (−0.019); the
  held-out lift over recency (+0.0695) is 57% of the train lift (+0.1225) -
  some train-noise exploitation, as expected for 8 free parameters on 289
  questions, but the majority of the lift generalizes.
- Frozen artifacts: `weights-learned.json` (flat, 8 keys, L2-normalized) +
  `weights-learned.meta.json` (winner restart, per-restart trajectories,
  pinned-zero list, configHash f4344541d..., frozenAt 2026-08-10T11:05:21Z).

## The learned vector (signs tell the story)

`age_days -0.32, content_length -0.62, retrieval_count -0.54,
outcome_negative +0.38, outcome_positive +0.23, half_life_days +0.11,
outcome_ratio +0.08, strength -0.06`

Descriptively: on this substrate the gold-densest rows are FRESH (recency
still carries the largest single-factor signal), SHORT (evidence turns are
typically the concise answer-bearing statements, not the long context
dumps), and NOT the rows the anti-oracle usage simulation happened to
retrieve and strengthen. Two readings, both pre-committed:

1. The combination is real signal the single factors cannot express -
   retention lifts from 0.4203 to 0.4897 by trading off freshness against
   brevity and against simulated-usage popularity.
2. The usage-feature SIGNS here (negative retrieval_count, positive
   outcome_negative) reflect E1's deliberately uninformative anti-oracle
   simulation, NOT real usage value. They must not be interpreted as "hippo
   should down-rank retrieved memories" in production. LC3 (dogfood traces,
   real outcomes) remains the test of usage features. This caveat rides the
   weights artifact into any E3 wiring discussion.

## Interpretation (per the locked pre-commitments)

Pre-commitment 1 fires: the weights JSON is the opt-in, derived,
rebuildable, git-diffable artifact (Track L Rule 2) that E3 wires into a
real decision site behind a config flag, default off, next episode. ROADMAP
Part IV LC2 status updated this episode. hippo's hand-set `strength`
composite (held-out 0.3049, chance-level) now has a measured, reproducible
successor candidate on this substrate.

What this does NOT claim: no production behavior changed this episode (the
weights ship as an artifact, nothing reads them in src/); no claim about
LoCoMo/LongMemEval retrieval metrics (this is a retention-under-budget
eval); no claim that these weights transfer to dogfood stores (LC3
question); no re-assertion of any retracted magnitude.

## Verification trail

- Prereg locked before the fit with three independent integrity-gate
  confirmations (executor, code-review-critic, orchestrator) and 14/14
  mechanism tests.
- Full suite before the fit: 2888/2888 tests pass. One test-isolation
  defect in the NEW fit test file was found by the full-suite run (parallel
  vitest workers sharing the fixture scratch root with the E1 harness test)
  and fixed in-stage with the established `HIPPO_MV_SCRATCH_ROOT` isolation
  pattern; 3-file concurrent run green (31/31) post-fix. Pre-existing local
  flake (not this episode): `dag-rebuild-summaries.test.ts` test #12 runs
  >60s in one vitest worker and trips the Windows worker-RPC
  `onTaskUpdate` timeout as a suite-level unhandled error on this box; file
  is byte-identical to green-CI master and passes alone (12/12).
- Held-out was evaluated exactly once, after freeze; `--report` consumed
  `evaluateAll`'s in-process pairedRecords.
