# LoCoMo Regression - Evidence Resolved

## Status

Resolved for the v0.32 vs current regression question: deterministic
gold-evidence recall does not show a meaningful retrieval regression.
Open for quality improvement: absolute LoCoMo evidence recall is still low.
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

Update 2026-04-27 final: `benchmarks/locomo/run.py` now supports
`--judge-backend claude-cli|openai|command`, stable per-conversation sampling,
and incomplete-run reporting. The 140-QA stable partial current run is useful
for miss analysis only. Main miss patterns: temporal anchoring misses,
recurring-topic distractors, photo/image evidence gaps, weak list aggregation,
and unsupported profile/inference questions.

Update 2026-04-28: Claude CLI quota recovered, but repeat judged runs still
failed with transient `judge rc=1`, and same-conversation scores moved by
about 0.03 across runs. The LLM judge is too noisy for the v0.32 vs current
question. Added deterministic evidence scoring:

```bash
python benchmarks/locomo/score_evidence.py \
  --data benchmarks/locomo/data/locomo10.json \
  --result benchmarks/locomo/results/hippo-v0.32.0.json \
  --output benchmarks/locomo/results/hippo-v0.32.0-evidence.json

python benchmarks/locomo/score_evidence.py \
  --data benchmarks/locomo/data/locomo10.json \
  --result benchmarks/locomo/results/hippo-v0.34.0-no-salience.json \
  --output benchmarks/locomo/results/hippo-v0.34.0-no-salience-evidence.json
```

Full-file deterministic rescore, top-k evidence recall@5:

| Run | hippo_version in JSON | scored QAs | evidence recall@5 |
|---|---:|---:|---:|
| `hippo-v0.32.0.json` | 0.32.0 | 1,982 | **0.172748** |
| `hippo-v0.34.0-no-salience.json` | 0.33.0 | 1,982 | **0.172499** |

Delta = -0.000249, effectively zero. Row-level, current is better on 62 QAs,
worse on 62 QAs, and unchanged on 1,858 scored QAs. Four QAs have no gold
evidence and are unscored. Conclusion: the apparent judged gap was a judge
failure/noise artifact, not a v0.32-to-current retrieval regression.

## What we know so far

| Run | Code | Salience | mean_score | n_equivalent / 1986 |
|---|---|---|---|---|
| 2026-04-24 v0.32.0 | tag `v0.32.0` | n/a (didn't exist) | **0.279** | 429 |
| 2026-04-24 v0.34 pineal-salience-on | working tree | force-on | **0.020** | 23 |
| 2026-04-25 v0.34 salience-off | working tree | default off | **0.139** | 205 |

Those judged scores are now known to be contaminated by judge failures. The
deterministic evidence rescore says salience-off/current and v0.32 retrieve
gold evidence at the same rate. Two separate things remain:

1. The salience contribution itself (0.139 vs 0.020 = ~7x) is the
   biggest single signal so far. Mechanism: write-time lexical-overlap
   gate drops same-conversation continuation turns, which is most of
   LoCoMo by construction.
2. Absolute evidence recall is low (~17.3% recall@5), especially temporal
   and adversarial categories. That is the next LoCoMo improvement target.

## Things that are NOT yet known and must be re-verified

- Were the v0.32 and v0.34 stores built from the same corpus the same
  way, or are there ingest-path / consolidation differences?
- Was the same retrieval harness used for both runs? (`benchmarks/locomo/run.py`
  shells out per QA, similar to `retrieve.py` on LongMemEval. Check whether
  budget/min-results choices are equivalent across the runs being compared.)
- Per-conversation isolation: LoCoMo creates a fresh HIPPO_HOME per
  conversation. Verify that's identical across runs.

## Repro Plan

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
4. Prefer deterministic evidence scoring for regression checks:
   `python benchmarks/locomo/score_evidence.py --data benchmarks/locomo/data/locomo10.json --result <json> --output <json>`.
   Use LLM judges only for answer-quality reporting, not regression triage.
5. If a future regression survives matched stores + deterministic evidence
   scoring, then bisect. Not before.

## Hard rules

- Do not enable salience.
- Do not skip step 1 (matched stores).
- Do not run anything until step 3's harness is sanity-checked the same
  way LongMemEval was — half a day was burned on a `retrieve.py` /
  budget-4000 artifact there. Same trap likely applies here.
- If a regression survives matched stores + matched harness + deterministic
  evidence scoring, then bisect.
  Not before.
