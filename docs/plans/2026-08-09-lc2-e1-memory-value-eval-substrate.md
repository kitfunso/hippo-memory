# LC2-E1: Memory-value eval substrate

Status: Draft (episode 01KZHN3SM9A92V1WE23YQ76HZE, plan stage)
Date: 2026-08-09
Scope: first of three A-sized slices of ROADMAP Part IV LC2 (learned linear memory-value scorer)

## Context

LC2 replicates the arXiv 2606.12945 recipe on hippo's substrate: a linear, inspectable value function over consolidation-time lifecycle features, fit gradient-free against gold-evidence retention on LongMemEval under a fixed keep budget. The track decomposes into:

- **E1 (this plan): the eval substrate.** Feature extractor, retention harness, train/held-out split, baselines, pre-registration doc. Eval-only.
- **E2: the fitter.** Hill-climb/CMA-ES over the linear weights; derived, rebuildable, git-diffable weights JSON (Track L Rule 2; `hybrid_tuning_winners.json` precedent). Judged against E1's pre-registered bars.
- **E3: opt-in integration + gates.** Wire into real decision sites behind a config block (salience/mmr precedent, default off); paired A/B + LongMemEval per-haystack R@5 non-regression per `docs/RETRACTION.md`.

Binding constraints discovered before this plan:

1. **Stored-strength writes are inert.** `calculateStrength` (`src/memory.ts:309-385`) recomputes from `last_retrieved`/`half_life_days`/reward and never reads the stored `strength` field (lifecycle-stress eval result, `docs/evals/2026-06-09-lifecycle-stress-eval-result.md`). E1's extractor therefore reads raw fields and *derives* strength via `calculateStrength` at extraction time; nothing in the LC2 track may act by writing stored strength.
2. **No held-out split mechanism exists** in `benchmarks/longmemeval/` — it is new work here.
3. **Fire-rate naming gap.** ROADMAP's "tier-1 micro-eval fire-rate" is computed by `benchmarks/ab/run.py` (LoCoMo paired A/B: fire-rate + Wilcoxon + sign test), not by `benchmarks/micro/run.py` (pass-rate only). The pre-reg doc resolves this explicitly: the E3 gate is the `benchmarks/ab` methodology.
4. **RETRACTION.md discipline**: no pre-commitment is binding without a source-read of the depended-on code paths AND a 1-question dry-run through the actual mechanism confirming it fires, before pre-reg locks. Both happen inside E1.
5. **Leakage rule (from brainstorm, carried forward): no eval-question text may influence any feature.** Usage simulation derives queries from haystack session content only, never from question text, on both splits uniformly.

## Deliverables

```
benchmarks/memory-value/
  README.md         purpose, exact data URL, usage, protocol summary; explicit note that the dataset
                    lives in the MAIN checkout's data dir (episode worktrees must pass --data <abs path>)
  split.mjs         seeded (seed=42), question-level, stratified by question_type; 300 train / 200 held-out; emits split.json
  ingest.mjs        per-question haystack -> scratch hippo store (per-turn chunking, mirroring chunk-per-turn precedent);
                    records session_id -> memory_id map; ingest honors haystack_dates so age varies (HIPPO_FAKE_NOW per session)
  simulate.mjs      usage simulation: N seeded recall+outcome rounds per store, queries sampled from session content
                    (never question text); via real hippo recall/outcome paths so retrieval_count/outcome counters/last_retrieved move
  extract.mjs       blind per-memory feature vectors -> features.jsonl; derived strength via calculateStrength at extract time
  evaluate.mjs      scorers: uniform / each-single-factor(both signs) / recency / --weights <file> (E2 hook);
                    retention@budget per question, averaged per split; paired per-question records for bootstrap
  run.mjs           orchestrator: --smoke | --questions N | --full; --data <path>; --budget 0.3; results JSON under results/
docs/evals/2026-08-09-lc2-memory-value-prereg.md   pre-registered protocol + E2 bars + dry-run evidence
tests/memory-value-harness.test.ts                  deterministic smoke on a small synthetic fixture (real SQLite store)
benchmarks/longmemeval/README.md                    +1 line: exact dataset URL (fixes recorded friction)
```

## Protocol decisions (to be locked in the pre-reg doc)

- **Substrate**: per-question haystack stores (matches LongMemEval standard task and prior per-haystack work). Gold = evidence-TURN-level: memories from turns flagged `has_answer` inside `answer_session_ids` sessions, IF the cleaned dataset retains those flags (verify at execute); fallback = all turns of answer sessions, documented as the coarser target. Retention(q) = |gold ∩ kept| / |gold|; split score = mean over questions.
- **Keep budget**: 0.30 primary (paper-matching); 0.10/0.20/0.50 reported descriptively, no bars.
- **Scorer definitions + deterministic tie-break**: "uniform" = equal weights (1/K) over the normalized K-dim feature vector (the paper's uniform-weights baseline), NOT a constant score. Keep set = top ceil(budget·N) under the total order (score DESC, memory_id ASC), stable sort, applied identically to every scorer. Cutoff-boundary score pairs are printed full-precision in the results JSON (measure-ties discipline) so any tie-heavy scorer is visible, not silently resolved.
- **Sign orientation (before the uniform sum)**: every feature is oriented keep-positive; a declared orientation map in the pre-reg doc lists the negated features — `age_days` (recency-positive) and `outcome_negative` (harm-negative). The error-tag flag is NOT negated: hippo's own `deriveHalfLife` doubles error-tag half-life (errors are lessons), and the orientation follows product semantics, not surface polarity. Single-factor baselines still evaluate both signs, so orientation choices cannot hide a better inverted factor.
- **Split**: seed 42, stratified 60/40 by question_type over the 500 questions of `longmemeval_s_cleaned.json` (counts: multi-session 133, temporal-reasoning 133, knowledge-update 78, single-session-user 70, single-session-assistant 56, single-session-preference 30).
- **Features (blind vector v1)**: age_days (from haystack_dates), half_life_days (derived), computed strength (calculateStrength at extract time), retrieval_count, outcome_positive, outcome_negative, outcome_ratio, valence class one-hot, schema_fit, layer one-hot, kind one-hot, confidence one-hot (4 levels: verified/observed/inferred/stale — same treatment as the other categoricals), pinned, starred, error-tag flag, tag count, content_length, dag_level. Explicitly excluded: `bm25_score` and anything query-derived.
- **Clock convention (pinned, per store)**: ingest runs each session under `HIPPO_FAKE_NOW` = that session's haystack_date (so `created` and age vary); ALL simulation rounds run under `HIPPO_FAKE_NOW` = question_date; extraction computes calculateStrength and age_days at `HIPPO_FAKE_NOW` = question_date. Every temporal feature is therefore a pure function of the dataset + seed. Stated consequence: last_retrieved is effectively binary in this substrate (retrieved-at-question-date vs never); retrieval_count carries the usage gradation.
- **Normalization**: min-max per store, pre-registered (robust to cross-store scale drift). Constant feature within a store (min == max) normalizes to 0, never 0/0.
- **Simulation protocol** (the training-environment definition, pre-registered): fixed rounds per store, seeded UNIFORM query sampling from session turns, outcome assignment via hippo's real `outcomeForLastRecall` path. Same protocol on both splits; parameters live in one config block in `run.mjs` and are quoted verbatim in the pre-reg doc. Anti-oracle rationale stated explicitly: sampling is deliberately NOT biased toward likely-gold content (a gold-biased simulator would manufacture retrieval_count as a circular gold proxy). Consequence, also stated: usage features may carry near-zero gold signal on this substrate by design; a fitter that zeroes them is an honest outcome. Their live test is LC3 on real dogfood usage.
- **Runtime decision rule (pre-registered before any results)**: if full-500 ingest+simulate exceeds ~3h wallclock, drop to a seed-42 stratified 150-question subset and register that as the E1/E2 substrate. The choice is made on wallclock only, never on retention numbers.
- **E2 bars (pre-registered)**: learned weights beat BOTH uniform and the best single factor on held-out retention at budget 0.30, with a paired per-question bootstrap 95% CI (1000 resamples) on the difference excluding 0. Paper reference points: learned 0.770 vs uniform 0.657 vs best-single 0.518.
- **E3 gates (recorded now, executed in E3)**: `benchmarks/ab` paired A/B (fire-rate + Wilcoxon) on LoCoMo; LongMemEval per-haystack R@5 non-regression; salience-gate regression precedent (LoCoMo 0.139→0.020) is the named cautionary case.
- **Dogfood side-check (descriptive only)**: run `extract.mjs` over a scratch COPY of the live store (`HIPPO_HOME` scratch, Windows-style path under Git Bash, cwd with no `.hippo` ancestry); report feature distributions. Never a fitness target; the live store is never touched.

## Acceptance criteria (falsifiable)

1. `node benchmarks/memory-value/run.mjs --smoke` completes in <60s on the synthetic fixture and emits retention for uniform + all single factors + recency on both splits.
2. Full (or registered-subset) run completes on `longmemeval_s_cleaned.json`; results JSON has per-split, per-scorer retention at budget 0.30 + per-question records.
3. Feature-variance check passes: ≥6 features with non-zero variance post-simulation (else the simulation is degenerate and E1 fails loudly, not silently).
4. RETRACTION.md dry-run: 1 question driven end-to-end (ingest → simulate → extract → score → keep → retention) with evidence pasted in the pre-reg doc appendix.
5. Pre-reg doc contains the locked protocol + E2 bars, and states the fire-rate naming resolution.
6. `npm test` green; new test file runs against a real SQLite store; no diffs outside `benchmarks/memory-value/`, `benchmarks/longmemeval/README.md`, `docs/evals/`, `tests/`, `trajectories/`.

## Out of scope

The fitter (E2); any `src/` change; any config/CLI flag; version bump; npm publish; LC1 trace-schema changes; per-haystack R@5 re-runs.

## Risks

- **Ingest wallclock unknown** (prior 199k-turn dual-embedder run had no recorded wallclock). Mitigated by the pre-registered subset decision rule and `--questions N`.
- **Simulation degeneracy** (uniform usage → no feature variance). Mitigated by acceptance criterion 3; per the measure-ties discipline, score pairs print full-precision before any tie-break choice.
- **Embedder cost**: default zero-dep embedder (all-MiniLM via model-cache) is already vendored under `benchmarks/longmemeval/data/model-cache/`; reuse it, no new deps.
