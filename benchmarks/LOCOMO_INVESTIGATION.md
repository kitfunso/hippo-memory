# LoCoMo regression — open investigation

## Status

Open. Fresh repro needed under the canonical harness on matched stores.
Do NOT carry any framing from the (now closed) LongMemEval thread.

## What we know so far

| Run | Code | Salience | mean_score | n_equivalent / 1986 |
|---|---|---|---|---|
| 2026-04-24 v0.32.0 | tag `v0.32.0` | n/a (didn't exist) | **0.279** | 429 |
| 2026-04-24 v0.34 pineal-salience-on | working tree | force-on | **0.020** | 23 |
| 2026-04-25 v0.34 salience-off | working tree | default off | **0.139** | 205 |

So salience-off recovers most of the v0.34 hit (0.020 -> 0.139) but does
not return to the v0.32 baseline (0.279). Two separate things still need
verifying:

1. The salience contribution itself (0.139 vs 0.020 = ~7x) is the
   biggest single signal so far. Mechanism: write-time lexical-overlap
   gate drops same-conversation continuation turns, which is most of
   LoCoMo by construction.
2. The residual v0.34-salience-off vs v0.32 gap (~50%) has no proposed
   cause yet. Could be store/ingest difference, could be code.

## Things that are NOT yet known and must be re-verified

- Were the v0.32 and v0.34 stores built from the same corpus the same
  way, or are there ingest-path / consolidation differences?
- Was the same retrieval harness used for both runs? (`benchmarks/locomo/run.py`
  shells out per QA, similar to `retrieve.py` on LongMemEval. Check whether
  budget/min-results choices are equivalent across the runs being compared.)
- Per-conversation isolation: LoCoMo creates a fresh HIPPO_HOME per
  conversation. Verify that's identical across runs.

## Repro plan (do not start until LongMemEval is fully closed)

1. Build matched stores for v0.32.0 (or whichever known-good tag) and
   the current v0.34 working tree, both with `--no-hooks --no-schedule
   --no-learn` init, both with salience off, both via whatever ingest
   path each version supports cleanly.
2. Confirm memory counts and per-conversation distributions match.
3. Run `benchmarks/locomo/run.py` on each with identical flags. If the
   per-QA recall path uses CLI subprocess + low budget like LongMemEval
   did, fix that first by pointing it at an in-process equivalent OR
   bumping budget so it stops being the binding constraint.
4. Score, diff, decide.

## Hard rules

- Do not enable salience.
- Do not skip step 1 (matched stores).
- Do not run anything until step 3's harness is sanity-checked the same
  way LongMemEval was — half a day was burned on a `retrieve.py` /
  budget-4000 artifact there. Same trap likely applies here.
- If a regression survives matched stores + matched harness, then bisect.
  Not before.
