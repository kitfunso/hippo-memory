# F8 Stage-1 — discovery and termination note

**Date:** 2026-05-11
**Plan:** docs/plans/2026-05-11-r5-track1-hybrid-tuning.md
**Prereg:** docs/evals/2026-05-11-r5-track1-tuning-prereg.md
**Status:** Stages 2 and 3 not run. Plan paused pending HuggingFace access (see "Pivot" below).

This release does not re-assert the retracted −10pp magnitude.

---

## Discovery

Stage-1 ran 7 LongMemEval runs against `hippo_store2/` with `embeddingWeight ∈ {0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8}`. Aggregator output (`results/hybrid_tuning_2026-05-11T09-30-50-737Z_stage1/leaderboard.json`):

| label | recall@1 | recall@3 | recall@5 | recall@10 |
|---|---:|---:|---:|---:|
| ew_0.2 | 50.4 | 67.6 | 75.6 | 83.6 |
| ew_0.3 | 50.4 | 67.6 | 75.6 | 83.6 |
| ew_0.4 | 50.4 | 67.6 | 75.6 | 83.6 |
| ew_0.5 | 50.4 | 67.6 | 75.6 | 83.6 |
| ew_0.6 | 50.4 | 67.6 | 75.6 | 83.6 |
| ew_0.7 | 50.4 | 67.6 | 75.6 | 83.6 |
| ew_0.8 | 50.4 | 67.6 | 75.6 | 83.6 |

All seven runs produced byte-different JSONL retrievals (different orderings on individual queries) but identical R@K across all four K values. This is the byte-level equivalent of Gate-B FAIL, but the cause is upstream of the prereg's intent.

## Root cause

The `hippo_store2/` store at `.hippo/hippo.db` has 940 memories with raw session text and a working FTS index, but **no embeddings file exists at `.hippo/embeddings.json`**. The embeddings file is where `hybridSearch` reads cached cosine vectors (`src/embeddings.ts:233-247`). Without it, `loadEmbeddingIndex()` returns `{}`, every per-entry `cosine` is 0, and the BM25 + cosine combination collapses to a small perturbation of the BM25 ranking. Changing `embeddingWeight` only shuffles the rank order of ties; it does not change the answer-bearing top-K set for any of the 500 questions.

`ingest_direct.py` (used in F6 Task 10 to populate `hippo_store2/`) writes raw text and never invokes the embedding pipeline. `hippo embed` is the CLI command that builds the embeddings index, but it depends on the default embedding model `Xenova/all-MiniLM-L6-v2` (`src/embeddings.ts:26`), which is served from HuggingFace. The sandbox blocks `huggingface.co`. So:

- F6 R@5 = 75.6% on this workload was always pure BM25.
- F8's hybrid-tuning premise (sweep BM25 vs embedding weight) is null on this store.
- F9's cross-encoder reranks whatever the BM25-only path returns (the cross-encoder is a separate model, also HF-hosted; same blocker).
- F10's enrichment plan adds entry-level signal fields but does not address the embeddings absence.

## Verdict against Gate-B

Gate-B as written ("best-config R@5 ≥ baseline + 2pp") is technically FAIL — the best config matches baseline. But the verdict is **trivially FAIL because the workload is invalid for hyperparameter discrimination, not because tuning is exhausted**. Per the prereg's failure-handling clause, Gate-B FAIL is descriptive only and triggers no `src/` retraction. This document is the result-doc artefact for the run that ran.

## Why Stages 2 and 3 were not executed

Stages 2 and 3 vary `mmrLambda` and `(budget, min-results)` respectively. Both depend on a populated embedding index:

- MMR re-ranking computes diversification against pairwise cosine similarity. Without embeddings, MMR's diversity term is 0 for every candidate, so `mmrLambda` is degenerate.
- Candidate budget and min-results affect how many BM25 candidates feed the embedding rerank. Without embeddings, larger candidate pools widen the BM25 ranking only.

Running Stages 2 and 3 against the current store would produce 21 more identical R@K rows and consume ~28 min of compute. Pausing the plan is the honest move.

## Pivot

The right unblock is HuggingFace access (or a substitute embedding service). This is the same blocker called out in Plan F9 (`docs/plans/2026-05-11-r5-track2-cross-encoder-real.md`) Task 2, which scopes a multi-path discovery — try mirrors (`hf-mirror.com`), hosted reranker / embedding APIs (Cohere / Voyage / Jina), and vendored ONNX weights. The same discovery serves both:

- F8 re-run: build `hippo_store2/.hippo/embeddings.json` via `hippo embed`, then re-run Stages 1-3.
- F9: load the MS-MARCO cross-encoder for real-model rescoring.

Next action: dispatch F9 Task 2 (model-access discovery) before continuing either plan. F10 (richer ingest) can run independently; its enrichment is signal-extraction, not embedding-generation.

## Artefacts retained

- `scripts/aggregate_hybrid_tuning.mjs` (Task 4) — reusable on the re-run.
- `benchmarks/longmemeval/run_hybrid_tuning.mjs` (Task 3) — reusable on the re-run.
- `results/hybrid_tuning_winners.json` — currently has `{"embeddingWeight": 0.2}` from a degenerate sort-stable tie; will be overwritten on re-run.
- The Stage-1 sweep output dir is gitignored and will be regenerated.

The prereg, Stage-1 orchestrator, aggregator, and winners file are all kept on the branch; the result doc this note functions as documents the pause.

## Cumulative-null status

Per `docs/RETRACTION.md:94-113`, the dlPFC goal-stack mechanism's cumulative-null status is independent of this plan, which changes no `src/` mechanism. The pause here does not alter that status.
