# LoCoMo regression — open investigation

## Status

Open. Fresh repro needed under the canonical harness on matched stores.
Do NOT carry any framing from the (now closed) LongMemEval thread.

Update 2026-04-27: existing full LoCoMo result files are contaminated by
Claude judge subprocess failures. `run-no-salience.log` contains 1,377
`judge rc=1` warnings, starting in conv-42; conv-44 through conv-50 in
`hippo-v0.34.0-no-salience.json` are all scored `wrong` despite non-empty
top-k memories. `run-v0.32.0.log` also has 528 judge failures. Treat those
published aggregate scores as suspect until rerun with judge failures
aborting rather than scoring as wrong.

Update 2026-04-27 later: matched-store audit passed for all 10 LoCoMo
conversations comparing v0.32.0 vs current: both stored 5,882 / 5,882
expected turns, with zero stored-count delta and zero sampled budget-capped
recall probes. Current judged smoke on conv-26 completed 20 QAs with no
judge failures, but the broader stable 10x20 judged run hit Claude's monthly
usage limit after 140 QAs (`claude -p` now returns "You've hit your org's
monthly usage limit"). Do not treat partial judged JSONs as benchmark scores.

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
2. Confirm memory counts and per-conversation distributions match. Use
   `benchmarks/locomo/audit_matched_stores.py` for the first cheap pass:
   it builds fresh temp stores, exports counts, and probes configured vs
   high-budget recall without running the Claude judge. Use `--max-turns`
   only for smoke checks; omit it for real matched-store parity.
3. Run `benchmarks/locomo/run.py` on each with identical flags. Keep the
   recall preflight enabled: it compares the configured `--budget` against
   a high-budget probe before judging and aborts if top-k recall is capped.
   If it fails, raise `--budget` before scoring.
4. Wait for Claude judge quota or switch to a reliable judge. Then resume
   `hippo-current-10conv-20qa-stable.json` with `--resume` and run the same
   stable sample against v0.32.0 via `HIPPO_BIN='node C:/Users/skf_s/hippo-v032/bin/hippo.js'`.
5. Score, diff, decide.

## Hard rules

- Do not enable salience.
- Do not skip step 1 (matched stores).
- Do not run anything until step 3's harness is sanity-checked the same
  way LongMemEval was — half a day was burned on a `retrieve.py` /
  budget-4000 artifact there. Same trap likely applies here.
- If a regression survives matched stores + matched harness, then bisect.
  Not before.
