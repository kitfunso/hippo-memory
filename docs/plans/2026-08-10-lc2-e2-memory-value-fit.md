# LC2-E2: memory-value fitter (learned linear weights)

Status: Draft (episode 01KZNFYSCS1EFZY5HYFZGR8GB0, plan stage)
Parent: `docs/plans/2026-08-09-lc2-e1-memory-value-eval-substrate.md` (E1, shipped PR #138)
Bars source: `docs/evals/2026-08-09-lc2-memory-value-prereg.md` + `docs/evals/2026-08-09-lc2-memory-value-result.md` (v4, registered)
Roadmap: Part IV Track LC, item LC2.

## Goal

Fit the linear memory-value scorer on the E1 retention substrate and judge it
against the pre-registered bars. One sentence: learn signed weights over the
8 live lifecycle dims that keep more gold evidence at budget 0.30 than any
single factor does.

## Bars (locked by E1's prereg; restated, not renegotiated)

On HELD-OUT (190 questions) at keep budget 0.30:

- learned > uniform (0.2468) AND learned > best single factor = recency (0.4203),
- paired per-question bootstrap 95% CI (1000 resamples, seed 42) on each
  difference excluding 0,
- fit uses TRAIN only (289 questions; recency there = 0.3862),
- held-out is evaluated ONCE, after the fitter freezes.

The operative bar is 0.4203. Beating recency is the whole game.

## Design decisions (the load-bearing ones)

1. **Objective = the shipped scoring path, not a reimplementation.**
   `fit.mjs` imports `evaluateStore`/`evaluateAll` from `evaluate.mjs` and
   maximizes TRAIN mean gold retention @ 0.30 for a candidate weight vector.
   Zero drift between fitting and judging by construction. Binding details
   (grill round + plan-eng-critic round 1, 2026-08-10):
   - **Caching contract (critic r1 must-fix 2):** `evaluateAll` re-reads
     `features.jsonl` from disk inside its per-question loop on every call
     (evaluate.mjs:299-301) - calling it per candidate is disk-bound.
     Instead, `fit.mjs` reads each train question's rows from disk ONCE at
     startup (via the same `featuresPathFor`/`readJsonl` helpers) and holds
     them in memory; each ES candidate then calls the exported
     `evaluateStore(rows, budgets, weights)` per train question on the
     cached rows. ALL scoring, normalization, keep-set, and retention
     semantics live in the imported, unmodified `evaluateStore`. Accepted
     waste: `evaluateStore` internally builds all ~62 scorers per call
     (buildScorers); only the `weighted` scorer's retention is consumed.
   - **The only arithmetic `fit.mjs` adds is the train mean** over
     per-question `weighted` retentions at budget 0.30, with the IDENTICAL
     zero-gold skip rule as the registered summary. The fitter iterates
     ALL 300 committed train ids and applies the zero-gold skip at
     runtime, mirroring `evaluateAll`'s own loop - it does NOT pre-filter
     to the 289 known non-zero-gold ids. This is not taken on
     trust: a pinned cross-check test requires `fit.mjs`'s objective for
     the pure recency vector to reproduce the registered train recency
     0.3862 at 4dp - any drift in the mean/skip rule fails loudly.
   - **Scorer key naming:** `buildScorers` names the weights-driven scorer
     `weighted` - that literal key appears in `pairedRecords`/summary and
     is what `--report` filters on; the docs present it as "learned".
   - `--report` consumes the `pairedRecords` array `evaluateAll` RETURNS
     in-process (evaluate.mjs:411) for the one post-freeze held-out run -
     no dependency on CLI output files, no harness change.
2. **Search space = the 8 live dims only** (`age_days`, `half_life_days`,
   `strength`, `retrieval_count`, `outcome_positive`, `outcome_negative`,
   `outcome_ratio`, `content_length`), signed, box [-1, 1]. The 22 dead dims
   are EXCLUDED from the weights file (missing keys score 0 by the
   evaluate.mjs contract; within-store min-max already sends them to 0, so
   exclusion is deterministic-equivalent to fitting them). The result doc
   records the pinned-zero list.
3. **Optimizer: seeded (1+lambda)-ES, in-repo, no new deps** (rule 18: npm
   search surfaced no maintained JS CMA-ES; the paper itself used a
   hill-climb stand-in for CMA-ES). The ES core is an objective-agnostic
   pure function (`runES({objective, dims, rng, ...})`) so its mechanics
   are testable against synthetic objectives without any store fixture.
   Spec, all pre-registered:
   - lambda = 8, Gaussian mutation, sigma_0 = 0.3, clip to box;
   - sigma halves after 5 consecutive non-improving generations;
   - stop at 60 generations or sigma < 0.01;
   - improvement = strictly greater train objective (ties never move the
     parent - `feedback_measure_ties_before_fixing` [PROBATION]);
   - 5 restarts, PRNG = the harness's own `rngFor('fit', restartIndex)`
     (common.mjs mulberry32, GLOBAL_SEED 42); best train objective wins,
     restart-index ascending breaks exact ties;
   - restart 0 INITIALIZES AT the recency vector (age_days = -1, rest 0):
     the search starts from the incumbent best single factor, so
     learned >= recency on TRAIN by construction; restarts 1-4 start at
     seeded random vectors in the box. Held-out remains the only real test.
   - L2-normalize the winning vector on emit (ranking is scale-invariant;
     normalization is for identifiability/diffability only);
   - zero-vector guard: a mutation with L2 norm < 1e-9 is rejected before
     evaluation (an all-zero vector scores every row 0 and hands the keep
     set to the tie-break; it also cannot be normalized on emit).
4. **Integrity gate BEFORE any fitting (rule 19 / stale-scratch check).**
   The E1 v4 scratch artifacts survive at `$TEMP/hippo-mv-stores`
   (500/500 dirs with `features.jsonl` + `gold.json` + `meta.json`,
   verified 2026-08-10). Gate, three assertions (critic r1 must-fix 1
   corrected the field targets):
   (a) split integrity: `split-registered.json`'s train/heldout id-array
   lengths (300/200) equal `results-latest.json`'s split block
   (`trainCount` 300 / `heldoutCount` 200);
   (b) inclusion integrity: the recency scorer's `questionsIncluded` at
   budget 0.30 in the reproduced summary equals the registered 289 train /
   190 heldout (the post-zero-gold counts live in the per-scorer summary,
   NOT the split block);
   (c) baseline reproduction: no-weights evaluation over the surviving
   scratch reproduces the registered numbers at 4dp - held-out recency
   0.4203, held-out uniform 0.2468, train recency 0.3862 - against the
   committed `results-latest.json`. Mismatch on any assertion => STOP, regenerate
   scratch with the full deterministic E1 pipeline (~81 min), re-gate.
   No fit runs against unverified features. Scope note: the gate re-derives
   already-REGISTERED baselines on held-out; the held-out-ONCE rule governs
   the LEARNED scorer only, which touches held-out exactly once, after
   freeze. The two disciplines do not conflict.
5. **Train-only discipline.** The fitter reads train ids from the COMMITTED
   registered split - `benchmarks/memory-value/split-registered.json` (seed,
   trainFraction, counts, id lists), never the mutable run-output
   `results/split.json`; the integrity gate additionally asserts the
   registered split's counts match `results-latest.json`'s split block
   (300/200 raw; the 289/190 post-zero-gold check is gate assertion (b)
   against the summary's `questionsIncluded`). Held-out ids are not loaded
   during fitting. Freeze = the weights
   JSON is written with its metadata block (seed, restarts, generations,
   final sigma, train objective, feature list, pinned-zero list, config
   hash = SHA-256 of `JSON.stringify(CONFIG)` over the frozen config.mjs
   object). Only then does the single held-out evaluation run - in-process
   via the exported `evaluateAll` with weights (decision 1's contract; the
   CLI `--weights` flag is the same code path but is not what `--report`
   depends on) - producing pairedRecords for the CI.
6. **CI computation.** `fit.mjs --report` consumes the held-out
   pairedRecords for (learned, recency, uniform), computes the two paired
   bootstrap CIs (1000 resamples, seed 42, percentile method, resampling
   questions with replacement). Bars met iff both point estimates are higher
   AND both CIs exclude 0 in the positive direction.
7. **Runtime budget.** One candidate = `evaluateStore` over 289 cached
   in-memory row sets, all ~62 scorers built per call (accepted waste, see
   decision 1); the E1 evaluate stage did 500 stores INCLUDING disk reads
   and variance in 1.9 s, so in-memory 289-store re-scoring is estimated
   well under 1.5 s per candidate. Worst case 5 restarts x 60 gen x 8
   offspring x 1.5 s ~= 60 min, inside the episode wallclock. Feature rows
   are disk-read once per process (all restarts in one node invocation).
   `fit.mjs --dry-run-timing` measures actual per-candidate cost on ~20
   candidates and projects the total BEFORE the real fit. Pre-registered
   fallback decided on that TIMING only, never on scores: projection
   > 75 min => drop to 2 restarts (0, 1) and record the amendment BEFORE
   the real fit.

## Interpretation pre-commitments (before any held-out number exists)

- **Bars met** -> the learned weights JSON becomes the opt-in artifact E3
  wires into a real decision site (next episode). ROADMAP LC2 status update.
- **Beats uniform but not recency** (CI includes 0 or point estimate below
  0.4203) -> honest bars-not-met result doc: this substrate carries no
  fittable linear signal beyond recency - consistent with E1's design
  (anti-oracle sampling makes usage dims chance-level). LC2 on THIS substrate
  is then measured-null; the next lever is LC3 (dogfood traces with real
  usage signal), NOT harness re-tuning (lifecycle-eval do-not-re-fix
  precedent). No re-runs, no post-hoc knob changes.
- **Learned < recency on TRAIN** -> impossible by construction (restart 0
  starts at recency and moves only on strict improvement); if observed it is
  a fitter bug - fix and re-run the FIT (train-side only); the held-out
  evaluation has not happened yet so no amendment is needed.
- **Harness defect discovered mid-episode** -> stop, fix, amend the prereg
  BEFORE any held-out run (E1's two-amendment precedent).

## Deliverables

| artifact | path |
|---|---|
| fitter + CLI (`fit`, `--report`, `--dry-run-timing`) | `benchmarks/memory-value/fit.mjs` |
| learned weights (committed, git-diffable; Track L Rule 2) | `benchmarks/memory-value/weights-learned.json` |
| prereg doc (locked before the held-out run) | `docs/evals/2026-08-10-lc2-e2-fit-prereg.md` |
| result doc (whatever the outcome) | `docs/evals/2026-08-10-lc2-e2-fit-result.md` |
| tests (real fixture, deterministic) | `tests/memory-value-fit.test.ts` |
| README section (fit + report commands) | `benchmarks/memory-value/README.md` |
| ROADMAP LC2 status line | `ROADMAP.md` (at ship) |

## Tests (all against the real 2-question hand-specified fixture / smoke substrate)

1. Same seed => byte-identical weights JSON (determinism).
2. Restart-0 invariant: final train objective >= recency train objective.
3. Weights file contract: only known feature names; loads through
   `evaluate.mjs --weights` without throw; dead dims absent.
4. Tie discipline: a mutation with EQUAL objective does not replace the
   parent (fixture constructed to force a tie).
5. Bootstrap CI: known toy pairedRecords input => hand-computable CI.
6. Integrity-gate check fails loudly on a tampered features.jsonl.
7. ES mechanics against synthetic objectives (no store fixture; `runES` is
   a pure function): sigma halves after exactly 5 consecutive
   non-improving generations; terminates at 60 generations and at
   sigma < 0.01 (whichever first, both exercised); cross-restart winner
   selection breaks exact train-objective ties by ascending restart index.
8. Recency cross-check (mean-rule anchor): `fit.mjs`'s objective for the
   pure recency vector equals the registered train recency 0.3862 at 4dp
   on the real scratch (run as part of the integrity gate, not CI tests).

## Non-goals (this episode)

No `src/` changes; no CLI flag or config surface in the product; no version
bump; no npm publish; no nonlinear/GBDT models (that comparison is LC3
territory); no new npm dependencies; no harness-mechanics changes except a
stopped-and-amended defect fix; no re-ingest unless the integrity gate fails.

## Risks

- **Overfit to train**: 8 linear dims on 289 questions is low-variance;
  held-out-once is the guard. No optimizer-hyperparameter tuning against
  held-out, ever.
- **Scratch drift** (another process touches $TEMP): integrity gate at 4dp
  catches it; deterministic regen path exists.
- **Ties under duplicate content**: keep-set already sorts
  (score DESC, sessionIndex, turnIdx, memory_id) - the fitter adds no new
  sort surface [PROBATION: feedback_deterministic_harness_no_foreign_tie_order].
- **Silent objective plateau** (all mutations rejected early): sigma-halving
  + restart diversity; the result doc reports per-restart trajectories.
