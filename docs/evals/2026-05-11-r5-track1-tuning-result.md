# LongMemEval R@5 target — Track 1 hybrid-tuning result

**Author:** Claude Code (subagent-driven-development workflow)
**Date:** 2026-05-11
**Plan:** docs/plans/2026-05-11-r5-track1-hybrid-tuning.md
**Prereg:** docs/evals/2026-05-11-r5-track1-tuning-prereg.md

This release does not re-assert the retracted −10pp magnitude.

---

## TL;DR

The full 28-run staged hyperparameter sweep over `hybridSearch` completed.
Best config: `embeddingWeight=0.5, mmrLambda=0.7, budget=50, minResults=5`.
Overall R@5 = 76.8% on LongMemEval 500-question workload.
Gate-A: PASS (28/28 runs). Gate-B: FAIL (76.8% < 77.6% threshold).

---

## Provenance

- Dataset: `data/longmemeval_oracle.json`
  SHA-256: `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c`
- Store: `hippo_store2/` (940 sessions, v0.27, embeddings populated via `hippo embed`
  using vendored `Xenova/all-MiniLM-L6-v2` ONNX weights, `HIPPO_MODEL_CACHE` set)
- Orchestrator: `benchmarks/longmemeval/run_hybrid_tuning_compact.mjs` (deletes each
  JSONL after evaluation to avoid disk exhaustion)
- Evaluator: `benchmarks/longmemeval/evaluate_retrieval.py`
- F6 baseline R@5 (pure BM25, no embeddings): 75.6%
- Gate-B threshold: 77.6% (baseline + 2pp)

---

## Sweep results

### Stage 1 — `embeddingWeight` sweep (7 runs)

Fixed: `mmrLambda=0.7` (default), `budget=1000000` (default), `minResults=10` (default).

Results dir: `results/hybrid_tuning_2026-05-11T10-19-25-968Z_stage1/`

| label   | recall@1 | recall@3 | recall@5 | recall@10 |
|---------|----------|----------|----------|-----------|
| ew_0.5  | 50.0     | 69.0     | 76.8     | 82.4      |
| ew_0.6  | 49.6     | 68.8     | 76.2     | 82.8      |
| ew_0.4  | 50.8     | 67.0     | 75.0     | 82.4      |
| ew_0.3  | 52.2     | 67.2     | 74.8     | 82.0      |
| ew_0.7  | 47.6     | 67.4     | 73.8     | 82.2      |
| ew_0.2  | 52.6     | 67.2     | 73.0     | 81.2      |
| ew_0.8  | 46.0     | 64.0     | 71.6     | 80.6      |

Winner: `embeddingWeight=0.5`

### Stage 2 — `mmrLambda` sweep (5 runs)

Fixed: `embeddingWeight=0.5`, `budget=1000000` (default), `minResults=10` (default).

Results dir: `results/hybrid_tuning_2026-05-11T10-41-04-045Z_stage2/`

| label  | recall@1 | recall@3 | recall@5 | recall@10 |
|--------|----------|----------|----------|-----------|
| ml_0.7 | 50.0     | 69.0     | 76.8     | 82.4      |
| ml_1   | 50.0     | 69.6     | 76.2     | 84.2      |
| ml_0.5 | 50.0     | 65.0     | 70.6     | 77.2      |
| ml_0.3 | 50.0     | 55.0     | 58.2     | 65.8      |
| ml_0   | 50.0     | 50.6     | 51.6     | 53.4      |

Winner: `mmrLambda=0.7`

### Stage 3 — `budget` × `minResults` grid (16 runs)

Fixed: `embeddingWeight=0.5`, `mmrLambda=0.7`.

Results dir: `results/hybrid_tuning_2026-05-11T10-56-00-495Z_stage3/`

All 16 cells produced R@5=76.8%, R@1=50.0%, R@3=69.0%.
R@10 varies: 76.8% when `minResults=5` (result count capped at 5), 82.4% otherwise.

| budget | minResults | recall@5 | recall@10 |
|--------|------------|----------|-----------|
| 50     | 5          | 76.8     | 76.8      |
| 50     | 10         | 76.8     | 82.4      |
| 50     | 20         | 76.8     | 82.4      |
| 50     | 50         | 76.8     | 82.4      |
| 100    | 5          | 76.8     | 76.8      |
| 100    | 10         | 76.8     | 82.4      |
| 100    | 20         | 76.8     | 82.4      |
| 100    | 50         | 76.8     | 82.4      |
| 500    | 5          | 76.8     | 76.8      |
| 500    | 10         | 76.8     | 82.4      |
| 500    | 20         | 76.8     | 82.4      |
| 500    | 50         | 76.8     | 82.4      |
| 1000   | 5          | 76.8     | 76.8      |
| 1000   | 10         | 76.8     | 82.4      |
| 1000   | 20         | 76.8     | 82.4      |
| 1000   | 50         | 76.8     | 82.4      |

Winner (sort-stable): `budget=50, minResults=5`.

Stage-3 degeneracy explanation: `budget` is a character-count / 4 token budget applied
after `minResults` are guaranteed. Since all tested `minResults` values are ≤ the
actual number of BM25 candidates returned, the `minResults` guarantee fires for every
query and the budget constraint is not active. All 16 cells are equivalent.

---

## Best-config confirmation run

Config: `embeddingWeight=0.5, mmrLambda=0.7, budget=50, minResults=5`

Artefact: `results/hybrid_tuning_best_v2/best.eval.json`

| metric               | value  |
|----------------------|--------|
| recall@1             | 50.0%  |
| recall@3             | 69.0%  |
| recall@5             | 76.8%  |
| recall@10            | 76.8%  |
| answer_in_content@5  | 51.0%  |

Per question type:

| type                        | count | recall@1 | recall@5 | answer_in_content@5 |
|-----------------------------|-------|----------|----------|---------------------|
| knowledge-update            | 78    | 62.8%    | 91.0%    | 53.8%               |
| multi-session               | 133   | 42.9%    | 78.2%    | 27.8%               |
| single-session-assistant    | 56    | 100.0%   | 100.0%   | 78.6%               |
| single-session-preference   | 30    | 16.7%    | 26.7%    | 73.3%               |
| single-session-user         | 70    | 41.4%    | 70.0%    | 74.3%               |
| temporal-reasoning          | 133   | 40.6%    | 72.2%    | 43.6%               |

---

## Gate verdicts

**Gate-A (sweep completion):** PASS. All 28 planned runs completed with non-empty
`*.eval.json` files. No harness crashes or evaluator errors.

**Gate-B (best-config improvement):** FAIL. Best R@5 = 76.8% < threshold 77.6%
(baseline 75.6% + 2pp). Per the prereg failure-handling clause, this verdict is
descriptive only. No `src/` changes were made; no retraction protocol fires.
The CHANGELOG and README do not advertise tuning as a value-add.
Plans F9 and F10 can proceed using the v0.27 default hyperparameters.

---

## Cumulative-null status

Per `docs/RETRACTION.md:94-113`, the dlPFC goal-stack mechanism's cumulative-null
status is independent of this hyperparameter-tuning work. This plan changed no
mechanism in `src/`; it operated solely on tuning parameters evaluated against a
different metric/corpus path. The cumulative-null finding for dlPFC goal-stack
therefore stands unchanged and is not affected by the outcomes of this sweep.
