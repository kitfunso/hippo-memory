# LC2-E2 pre-registration: linear memory-value fitter

Status: **LOCKED 2026-08-10** (dry-run evidence filled below; locked BEFORE
the real fit and BEFORE any held-out evaluation of the learned scorer). Amendments after lock follow the
E1 precedent: stop, amend with a dated record, then run - never amend after
a result exists.

Episode: 01KZNFYSCS1EFZY5HYFZGR8GB0. Plan: `docs/plans/2026-08-10-lc2-e2-memory-value-fit.md`
(eng-critic pass 89, round 2). Parent substrate: E1 v4 registered
(`2026-08-09-lc2-memory-value-result.md`; harness PR #138).

## Protocol (locked at lock time)

- **Substrate**: the E1 v4 extracted features surviving in the scratch root
  (`$TEMP/hippo-mv-stores`, 500/500 dirs) - subject to the integrity gate
  below. No re-ingest unless the gate fails; on gate failure the full
  deterministic E1 pipeline regenerates scratch and the gate re-runs.
- **Split**: the COMMITTED `benchmarks/memory-value/split-registered.json`
  (300 train / 200 heldout raw ids). The mutable `results/split.json` is
  never read.
- **Fitter**: seeded (1+lambda)-ES per plan decision 3 - lambda 8, sigma_0
  0.3, sigma halves after 5 consecutive non-improving generations, stop at
  60 generations or sigma < 0.01, box [-1,1], strict-improvement-only
  parent replacement, zero-vector guard (L2 < 1e-9 rejected), 5 restarts
  seeded by `rngFor('fit', restartIndex)` (mulberry32, GLOBAL_SEED 42).
  Restart 0 initializes AT the recency vector ({age_days: -1}); restarts
  1-4 at seeded random points. Winner = best TRAIN objective; exact ties
  break by ascending restart index. Winner L2-normalized on emit.
- **Search space**: the 8 within-store-varying dims only (`age_days`,
  `half_life_days`, `strength`, `retrieval_count`, `outcome_positive`,
  `outcome_negative`, `outcome_ratio`, `content_length`); the other 22
  CONFIG.FEATURES are pinned 0 by omission from the weights file
  (evaluate.mjs treats missing keys as 0; within-store min-max already
  zeroes them).
- **Objective**: TRAIN mean `weighted`-scorer gold retention at budget
  0.30, computed by the imported, unmodified `evaluateStore` over rows
  disk-read once per process; the mean iterates all 300 train ids with the
  runtime zero-gold skip rule identical to `evaluateAll`. Anchor: the pure
  recency vector must reproduce the registered train recency 0.3862 at 4dp
  (gate assertion below).
- **Freeze**: `weights-learned.json` (FLAT {feature: weight}, directly
  consumable by `evaluate.mjs --weights`) + `weights-learned.meta.json`
  (seeds, per-restart trajectories, winner, train objective, feature list,
  pinned-zero list, config hash, frozenAt) are written. After freeze, NO
  refitting: the held-out evaluation runs exactly once, in-process via the
  exported `evaluateAll`, whatever the outcome.
- **CI**: paired per-question bootstrap on held-out pairedRecords at budget
  0.30 - (weighted - recency) and (weighted - uniform) - 1000 resamples,
  seed 42 (`rngFor('report')`), percentile method, question ids resampled
  with replacement.

## Integrity gate (all must pass before the fit)

(a) `split-registered.json` train/heldout lengths = 300/200 =
`results-latest.json` split block trainCount/heldoutCount;
(b) reproduced recency `questionsIncluded` at budget 0.30 = 289 train /
190 heldout;
(c) reproduced baselines at 4dp: held-out recency 0.4203, held-out uniform
0.2468, train recency 0.3862;
(d) varying-features set in `results-latest.json` equals the 8 fit dims;
(e) recency-vector objective through the fitter's own path = 0.3862 at 4dp.

## Bars (unchanged from E1 prereg; restated verbatim in effect)

On HELD-OUT at keep budget 0.30: learned (`weighted`) beats uniform
(0.2468) AND the best single factor / recency (0.4203), with BOTH paired
bootstrap 95% CIs excluding 0 in the positive direction. Fit uses train
only. Held-out is evaluated once, post-freeze.

## Runtime decision rule (timing only, never scores)

`--dry-run-timing` measures ~20 seeded candidate evaluations and projects
the full 5-restart cost. Projection > 75 min => restarts drop to 2 (0, 1),
recorded here as a dated amendment BEFORE the real fit.

## Interpretation pre-commitments (locked before any held-out number exists)

1. **Bars met** -> the weights JSON is the opt-in artifact E3 wires next
   episode; ROADMAP LC2 status updated.
2. **Beats uniform but not recency** -> honest bars-not-met: the substrate
   carries no fittable linear signal beyond recency (consistent with E1's
   anti-oracle design making usage dims chance-level). LC2 on this
   substrate = measured-null; next lever is LC3 dogfood traces, NOT
   harness re-tuning. No re-runs, no post-hoc knob changes.
3. **Learned < recency on TRAIN** -> fitter bug by construction (restart 0
   starts at recency, strict-improvement moves); fix and refit train-side;
   no held-out number exists yet so no amendment.
4. **Harness defect found mid-episode** -> stop, fix, amend HERE before
   any held-out run (E1 two-amendment precedent).
5. Whatever the outcome, the result doc reports it per the honest-reporting
   + `docs/RETRACTION.md` discipline; the `weighted` scorer key is
   presented as "learned" in prose with the key name noted.

## Amendment 1 (2026-08-10, post-result hardening - dated per the E1 precedent)

Recorded AFTER the bars-met result existed, from the review round (codex
P1/P2s + /code-review 15 findings). Nothing here touches the optimizer, the
objective, the bars, or any PRNG stream; the ES search is bit-identical and
the refit must reproduce `weights-learned.json` byte-for-byte (verified in
the result doc's addendum). Changes:

1. Integrity gate extended: split duplicate/disjointness assertions;
   reproduced (live-scratch) varying-features tied to the registered set;
   TRAIN uniform meanRetention + questionsIncluded added to the baseline
   assertions (the all-features-sensitive statistic - closes the gate's
   blindness to non-age train-feature corruption; a committed per-question
   feature hash remains the airtight future fix); malformed input fails as
   named assertions, never TypeErrors.
2. The judgment path is now gated: `--report` runs the integrity gate and
   verifies the frozen meta's configHash before any held-out evaluation,
   and evaluates held-out ids only (provably number-preserving).
3. Freeze is mechanically enforced: refit refuses without `--force`; the
   report is additionally written to the COMMITTED
   `fit-report-registered.json` (E1 registration convention).
4. Meta sidecar completeness: per-restart trajectories retained (as this
   prereg promised); accurate seed-provenance fields added. CORRECTION to
   this prereg's own wording: the ES restarts and bootstrap draw from
   rngFor namespaces ('fit|<r>', 'report') which do NOT consume
   CONFIG.GLOBAL_SEED; GLOBAL_SEED parameterizes the E1 split/simulation
   substrate. The streams themselves are unchanged by this amendment.
5. Result-doc headline count corrected: held-out is 200 raw questions /
   190 non-zero-gold (the earlier "190/189" was a mis-derived count).

## Amendment 2 (2026-08-10, codex round-2 P2 closure - dated)

Applied after Amendment 1's verification re-run, before ship. No stream,
objective, or bar changes; weights remain byte-identical (re-proven by the
Amendment-2 refit).

1. **Freeze binding:** the meta sidecar now records `weightsFileSha256`
   (digest of the frozen weights file bytes); `--report` refuses a weights
   file whose digest, key set (FIT_DIMS only), or value finiteness does
   not match the freeze (`verifyFrozenWeights`). configHash alone bound
   the protocol, not the model.
2. **Held-out-once wording precisified:** the canonical judgment is the
   first post-freeze report; hardening-round reports are verification
   passes against byte-identical weights. The safeguard's substance - no
   refitting between looks - is unchanged and machine-evidenced.
3. **Reproduction path corrected:** `--report` is the non-destructive
   verification command (the bare fit now correctly refuses without
   `--force` on a checkout that already carries the frozen artifacts).
4. **Bootstrap seed description corrected:** the CI stream is
   `rngFor('report')` (namespace-derived mulberry32 seed); GLOBAL_SEED is
   not consumed by it.

## Dry-run evidence (filled before lock; empty = NOT LOCKED)

- Integrity gate: **PASSED** on the real scratch (500/500 dirs), three
  independent runs 2026-08-10 - executor (with `--dry-run-timing`),
  code-review-critic (2.7 s, standalone `runIntegrityGate()`), and
  orchestrator (`--dry-run-timing`, output below). All five assertions
  held: split 300/200, `questionsIncluded` 289/190, baselines
  0.4203/0.2468/0.3862 at 4dp, varying-features == FIT_DIMS, recency
  cross-check through the fitter's own objective path = 0.3862.
- Fixture/mechanism tests: **14/14 pass** (orchestrator re-run 12.2 s;
  critic independent re-run ~11 s) - `tests/memory-value-fit.test.ts`.
- `--dry-run-timing`: 1.0252 s/candidate uncontended (executor) and
  1.5010 s/candidate under concurrent full-test-suite load (orchestrator);
  projections 41.0 / 60.0 min for 2400 candidates. Both under the 75-min
  fallback threshold => **5 restarts stand; no amendment**. Verbatim
  orchestrator output:
  `[fit] dry-run-timing: 1.5010s/candidate over 20 candidates` /
  `[fit] projected total (5 restarts x 60 gens x 8 offspring = 2400 candidates): 60.0 min`.
- Lock stamp: **2026-08-10, episode 01KZNFYSCS1EFZY5HYFZGR8GB0** - locked
  by the orchestrator before `node fit.mjs` (the real fit) was invoked.
  Amendments after this line follow the E1 precedent (dated, before the
  affected run).
