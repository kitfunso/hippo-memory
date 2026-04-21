# O2 — FAISS / ChromaDB / LlamaIndex Head-to-Head (scope)

**Date:** 2026-04-21
**Purpose:** Scope the Frontier AI Discovery O2 deliverable: paired benchmark of hippo-memory vs FAISS, ChromaDB, LlamaIndex. Metric targets: MRR > 0.70, NDCG > 0.75 at 100K entries, <5% precision degradation after 30 days.

## What exists to reuse

**Python LongMemEval harness (`benchmarks/longmemeval/`):**
- `ingest.py`, `retrieve.py`, `evaluate_retrieval.py`, `run.py` — modular, isolates stores via HOME env override.
- `data/longmemeval_oracle.json` — 500 questions with ground-truth session IDs.

**TypeScript eval infra (`src/eval.ts`):**
- MRR / Recall@K / NDCG@K helpers; reusable once we aggregate results in JS.

**JS adapter pattern (`benchmarks/sequential-learning/adapters/`):**
- Interface already defined: `init / store / recall / outcome / cleanup`. Translates cleanly to Python.

## What's missing

**Python adapters** (parallel to existing `benchmarks/sequential-learning/adapters/hippo.mjs`):
- `benchmarks/longmemeval/adapters/faiss_adapter.py`
- `benchmarks/longmemeval/adapters/chromadb_adapter.py`
- `benchmarks/longmemeval/adapters/llamaindex_adapter.py`

**Python packages (not yet installed):**
```
faiss-cpu
chromadb >= 0.4.21
llama-index >= 0.10.0
```

**Harness orchestrator:**
- `benchmarks/longmemeval/benchmark_competitors.py` — 30 trials × per-backend, Recall@K / MRR / NDCG@K aggregation, CSV + markdown report.

## Corpus sizing — FLAG FOR USER DECISION

LongMemEval alone ingests ~1,500-2,000 session-memories. The grant targets **100K entries**. Two interpretations:

- **(A) Ingest 100K passages, query on 500 questions.** Easier — just a data scale test (e.g., Wikipedia passages). Measures whether retrieval still finds the right answer amid 100K distractors.
- **(B) Ingest AND query on 100K novel entries.** Harder — requires a 100K-question benchmark. None exists publicly; we'd need to synthesize one.

Recommendation: **(A)**. Defensible, testable, matches grant wording "at 100K entries" (not "100K questions").

## Suggested adapter interface

```python
class MemoryAdapter:
    def init(self, store_path: str) -> None: ...
    def ingest(self, passages: list[dict]) -> None: ...
    def query(self, q: str, k: int = 10) -> list[str]: ...  # top-k IDs
    def cleanup(self) -> None: ...
```

Each backend owns its store_path — isolation is the adapter's responsibility.

## Cost estimate

| Component | Hours |
|---|---|
| FAISS adapter | 4-6 |
| ChromaDB adapter | 3-4 |
| LlamaIndex adapter | 5-7 |
| Corpus scaling (Wikipedia subsampling to 100K) | 2-4 |
| Metric harness + 30-trial runner | 3-5 |
| Integration testing | 2-3 |
| **Total** | **19-29 hours** |

**Compute:**
- Ingest 1,500 sessions per backend: ~30-60 s/backend.
- Retrieve 500 queries per backend: ~5-15 min/backend.
- 30 trials × 3 backends: 15-18 hr wall-clock (parallelizable across processes).
- 100K corpus scale-up: add ~1-2 hr/backend for indexing.

## Recommended first milestone

**Ship FAISS-only head-to-head on LongMemEval 500** (≈ 6 hours):

1. Write `faiss_adapter.py` (init/ingest/query/cleanup).
2. Adapt `retrieve.py` to call the adapter instead of `hippo recall`.
3. Run on full 500 questions.
4. Compare vs hippo's known v0.28 baseline (R@5 = 73.8%, R@10 = 81.0%).
5. Output: one CSV + two-column metrics table.

**Then scale:** if FAISS results clear R@5 > 60%, add ChromaDB + LlamaIndex + 100K corpus in parallel.

## Risk table

| Risk | Mitigation |
|---|---|
| FAISS embedding choice dominates result | Use `@xenova/transformers` default model across all backends for parity. |
| 100K corpus expensive to store/index | Mmap indices to disk; ~500 MB per backend. |
| Ground-truth IDs don't match across corpora | Stick with LongMemEval's session IDs as anchor; 100K test uses synthetic IDs with known injection points. |
| Subscription-based judge for subjective answers | Not needed here — retrieval is scored against ground-truth session IDs. |

## Status

Scope approved (informally, by writing this doc). Not started. Reserved for a future focused session — do NOT fold into v0.29. First milestone (FAISS-only) is the unit of work; plan that separately when ready.
