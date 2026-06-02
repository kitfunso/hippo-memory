# L1 graph-retrieval stream — result

**Date:** 2026-06-02
**Prereg:** `docs/evals/2026-06-02-l1-graph-stream-prereg.md` (LOCKED — Gate (a) + Gate (b) PASS)
**Episode:** `01KT5302T7P2E2RGSZBMSMH03Y`
**Version:** 1.21.0

## Headline (honestly scoped)

The graph-retrieval stream **rescues the targeted lexically-weak-but-graph-adjacent class
into top-5 without harming controls**. This is a **mechanism result**, NOT a population-level
R@5 claim on a representative distribution — that is deferred to **L1-eval** (the
LongMemEval-oracle ablation, which needs a hippo entity graph built over the LME corpus).
Do not cite this as "L1 lifts R@5 on the oracle split."

## Mechanism ablation (real SQLite, `tests/search-graph-stream-rrf.test.ts`)

8-entry pool. Weights `[bm25=0.4, dense=0.6, graph=0.5]`, `k=60`, `absentRank=9`, top-3
lexical seeds.

| Query class | n | Answer fused rank, 2-stream | Answer fused rank, 3-stream | Verdict |
|---|---|---|---|---|
| **G** (lexically-weak, graph-adjacent to a seed) | 1 | **8 / 8** (outside top-5) | **4 / 8** (inside top-5) | rescued |
| **C-empty** (lexically-strong, empty graph) | 1 | **1 / 5** | **1 / 5** (stream empty → 2-list path) | no harm |
| **C-noise** (lexically-strong, no path; graph POPULATED, boosts a non-answer distractor) | 1 | **1 / 6** | **1 / 6** (distractor lifted but never reaches top) | no harm |

Per-query rank delta (G): **+4 positions** (rank 8 → 4). The graph stream is the only
changed input; the BM25 and dense rankings are identical in both runs. The **C-noise**
control is the stronger no-harm test (added at review on the independent-review-critic's
HIGH): with a *populated* graph that boosts a graph-adjacent distractor into the stream, a
true lexical answer with no graph path keeps rank 1 — the stream adds signal without
displacing a strong answer.

## Supporting evidence

- `tests/graph-stream.test.ts` — 11 producer tests: seed→neighbour scoring, per-hop decay
  ordering, fanout cap, local+global expansion, deterministic ties, empty-graph no-op,
  not-in-pool ignored, seeds-never-scored (incl. seed-adjacent-to-another-seed),
  `selectGraphSeeds` correctness.
- `tests/search-graph-stream-rrf.test.ts` — 4 fusion tests (the G dry-run, the C-empty
  no-harm, the **C-noise populated-graph no-displacement** control, and the empty-graph
  skip-path = byte-identical to the 2-list fusion).
- `tests/cli-graph-stream.test.ts` — 3 CLI smoke/validation tests.
- Full suite: 2483 passed (the single `server-concurrency.test.ts` failure is the known
  ECONNRESET env flake under full-suite parallelism — passes in isolation, no graph code).

## Scope boundaries (binding)

- **Within-pool only.** The stream re-ranks candidates already in the pool; it cannot
  rescue an answer absent from the pool (that is `graph-recall.ts`'s out-of-pool injection).
- **Anchors on the top-`seedCount` lexical hits.** On a pool with `<= seedCount` candidates,
  every candidate is a seed and the stream is inert (degrades to the 2-list fusion). The CLI
  default `seedCount` is 10; tune with `--graph-seeds`.
- **rrf-mode + embeddings required.** The stream lives in the rrf fusion path; without
  embeddings `hybridSearch` falls back to BM25-only and the stream is inert (the CLI says so).

## Deferred: L1-eval (population ablation)

Build a hippo entity graph over the LongMemEval oracle corpus (E3.1 extraction over the
sessions, entity→session mapping), then run the graph-stream-vs-no-graph-stream ablation
through a harness analogous to `benchmarks/longmemeval/chunk_per_turn_hybrid_retrieve.mjs`
to measure population R@5. Only L1-eval can substantiate "lifts R@5 on the oracle split."
