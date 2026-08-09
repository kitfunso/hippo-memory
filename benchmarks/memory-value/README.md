# LC2-E1: memory-value eval substrate

Eval-only harness for LC2 (learned linear memory-value scorer, ROADMAP Part
IV). This is E1: the feature extractor, retention harness, train/held-out
split, and baselines. No fitter, no `src/` changes, no production wiring —
see `docs/plans/2026-08-09-lc2-e1-memory-value-eval-substrate.md` for the
full protocol (E2 fits weights against these bars; E3 wires it into a real
decision site behind a config flag, opt-in, default off).

## Data

Dataset: `longmemeval_s_cleaned.json` (500 questions), exact URL:
https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json

It lives in the **main checkout's** data dir
(`benchmarks/longmemeval/data/`), which is gitignored and therefore **not
populated in episode worktrees**. Any run from a worktree must pass
`--data <absolute path to the main checkout's copy>`, e.g.:

```bash
node benchmarks/memory-value/run.mjs --data "C:\Users\<you>\hippo\benchmarks\longmemeval\data\longmemeval_s_cleaned.json" --questions 3
```

## Build prerequisite

All scripts import from `dist/` (compiled hippo, same convention as
`benchmarks/longmemeval/retrieve_inprocess.mjs`), not `src/`. Run
`npm run build` first if `dist/` is stale.

## Protocol summary

- **Substrate**: one scratch hippo store per question, the full haystack
  (all sessions, all turns) ingested as one memory per non-empty turn.
- **Gold**: evidence-turn level when the dataset's `has_answer` flag is
  present on answer-session turns (auto-detected per question), else every
  turn of every answer session. `retention(q) = |gold ∩ kept| / |gold|`;
  questions with 0 gold turns are skipped from the mean but counted.
- **Clock**: ingest stamps each session under `HIPPO_FAKE_NOW` = that
  session's real `haystack_date`; all usage-simulation rounds and feature
  extraction run under `HIPPO_FAKE_NOW` = `question_date`.
- **Usage simulation**: `SIM_ROUNDS` (30) seeded recall+outcome rounds per
  store. Query = a uniformly-sampled turn's content from THAT STORE's own
  sessions (never the eval question/answer text — the leakage rule), top-K
  via hippo's real `hybridSearch`, strengthening via the real
  `markRetrieved` + `writeEntry`, outcome via the real `applyOutcome` +
  `writeEntry` applied to that same round's just-recalled ids. Round index
  `r % 3 === 2` gets a negative outcome, else positive.
- **Features**: 30-dim blind vector (`config.mjs` `FEATURES`) — lifecycle
  scalars (age, half-life, derived strength, retrieval/outcome counts) plus
  one-hot valence/layer/kind/confidence. Never query-derived; `bm25_score`
  is explicitly excluded.
- **Normalization**: min-max per store; a feature constant within a store
  normalizes to 0 (never 0/0).
- **Scorers**: uniform (1/K oriented sum), every single factor at both
  signs, recency (age only), and a `--weights <file>` hook for E2's learned
  weights. Note: `age_days__neg` (the single-factor sweep's negative-sign
  age_days scorer) is mathematically identical to `recency` — both are
  `-norm(age_days)`. This duplication is kept intentionally (paper parity:
  "recency" as its own named baseline vs. the single-factor-both-signs
  sweep are two separate protocol asks) and is harmless — it just means the
  results JSON carries the same number under two scorer names.
- **Keep set**: top `ceil(budget * N)` by `(score DESC, memory_id ASC)`,
  stable, identical rule for every scorer. `KEEP_BUDGETS` = [0.1, 0.2, 0.3,
  0.5]; 0.3 is primary (the only budget with per-question paired records for
  bootstrap; the rest are descriptive-only, per the pre-reg).
- **Dataset-wide variance gate**: `evaluate.mjs` computes RAW (pre-
  normalization) variance per feature across every processed question and
  reports `varyingFeatures` / `deadFeatures` explicitly. A dead feature
  (constant everywhere) min-max normalizes to 0 in every store, so it is
  provably inert for the uniform/weighted scorers; its single-factor summary
  cells are marked `degenerate: true` / `degenerateReason: "tie-break-only"`
  and excluded from `bestSingleFactor`. `run.mjs` hard-fails (nonzero exit)
  on any real (non-`--smoke`) run with fewer than 6 dataset-wide-varying
  features.

All of the above numbers are pinned in `config.mjs` as one frozen object —
that file is the single source of truth if this README and the config ever
drift.

### Dead dims on this substrate

Fresh, untagged chat ingest genuinely cannot vary several of the 30
declared dims — this is a real property of the substrate, not a harness
bug:

- `layer` (always `episodic`), `kind` (always `raw`), `confidence` (always
  `verified`), `pinned`/`starred` (always `false`), `dag_level` (always `0`,
  no DAG is built), `tag_count`/`error_tag` (always `0`, no tags — see the
  leakage-rule note above) — every ingested turn takes hippo's `createMemory`
  defaults on every one of these dims, on every question, by construction.
- `valence` is inferred from tags only (`inferValence(tags)`,
  `src/memory.ts:618`); with `tags=[]` always, `neutral` is the one real
  value — this is not a stub, it is what production actually computes for
  untagged content.
- `schema_fit` is wired to the REAL write-time `computeSchemaFit(text, [],
  entriesIngestedSoFarInThisStore)` call (mirrors `src/cli.ts:740`), but
  measured empirically: `computeSchemaFit`'s tag-overlap guard
  (`src/memory.ts:568`, `tags.length === 0 && tagFreq.size === 0`) returns
  the neutral `0.5` before ever reaching the content-overlap branch —
  because `tagFreq` is built from OTHER entries' tags, and no entry in this
  substrate ever carries a tag, the guard fires on every call regardless of
  content. `schema_fit` is therefore also dataset-wide constant on real
  LongMemEval data (real function, real path — genuinely inert on this
  input, not an unwired default).

All of the above dims would vary on a dogfood/consolidated store (real
tagged usage, DAG summaries, pinned/starred user actions, non-`verified`
confidence from staleness) — they simply don't have a source of variation
in a from-scratch, single-pass chat ingest. The 8 lifecycle-usage dims
(`age_days`, `half_life_days`, `strength`, `retrieval_count`,
`outcome_positive`, `outcome_negative`, `outcome_ratio`, `content_length`)
are the real signal on this substrate; the variance gate above enforces
that at least 6 of them (or any other varying dims) are present before a
real run's results are treated as meaningful.

## Pipeline

```
split.mjs      seeded 60/40 train/heldout, stratified by question_type -> results/split.json
ingest.mjs     per-question haystack -> scratch hippo store (per-turn chunking)
simulate.mjs   usage simulation (recall + outcome rounds)
extract.mjs    blind per-memory features -> <scratch>/<question_id>/features.jsonl
evaluate.mjs   normalization, scorers, keep-selection, retention
run.mjs        orchestrates all of the above; prints per-stage timings
```

Scratch stores live under `os.tmpdir()/hippo-mv-stores/<question_id>/`
(never under the repo, never touching `~/.hippo`), and are deleted after
extraction by default (`--keep-stores` to retain).

## Commands

```bash
# Smoke: synthetic 12-question fixture, no --data needed, <60s.
node benchmarks/memory-value/run.mjs --smoke

# Real data, small subset (seeded stratified-by-type sample).
node benchmarks/memory-value/run.mjs --data <abs path> --questions 3

# Full run (or a larger registered subset per the runtime decision rule —
# see the plan doc: if full-500 exceeds ~3h wallclock, drop to a seed-42
# stratified 150-question subset).
node benchmarks/memory-value/run.mjs --data <abs path>

# Ablation: features without any usage simulation.
node benchmarks/memory-value/run.mjs --data <abs path> --skip-simulate

# E2 hook: score with learned weights instead of the built-in scorers.
node benchmarks/memory-value/run.mjs --data <abs path> --weights weights.json
```

Results land in `results/<timestamp>.json` and `results/latest.json`
(`-smoke` suffix on smoke runs). Each results file embeds the full `config`
block it was generated under, per-stage timings, gold-mode counts, the
summary (mean retention per split/scorer/budget), and `pairedRecords`
(primary-budget, every scorer, every question — the bootstrap input for
E2's paired-CI bars).

## Tests

`tests/memory-value-harness.test.ts` — deterministic smoke against real
SQLite scratch stores (a hand-specified 2-question fixture, not the seeded
`--smoke` generator, so retention numbers are hand-verifiable). Run via the
normal `npm test`.
