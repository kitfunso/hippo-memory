# LongMemEval-S retrieval: per-haystack dual-embedder measurement + global-pool correction (2026-06-09)

## Summary

Two findings:

1. **Correction.** The F-track `_s` results (F14, F15, F16, F9; see ROADMAP Part II / Track F) and their conclusion that "the locally-runnable embedder is the structural ceiling on `_s`, only `text-embedding-3-large` (F17, egress-blocked) closes the gap to gbrain's 97.6" were measured with a **global-pool** harness: each question's answer session was ranked against the union of all 19,195 `_s` sessions, with **no per-question haystack filter**. Standard LongMemEval-S (and gbrain's 97.6) score within each question's own ~48-session haystack. The two are different tasks; the F-track compared a global-pool number to a per-haystack number.

2. **Result.** On the standard per-haystack task, hippo's **zero-dependency default (MiniLM-L6) reaches R@5 98.6**, above gbrain's published 97.6. A frontier embedder (voyage-3-large, opt-in via the v1.23.0 pluggable provider) adds +1.2 to 99.8. The embedder is not the bottleneck on the standard task; `text-embedding-3-large` / F17 was never required.

## Method

- **Data:** `longmemeval_s_cleaned.json` (HuggingFace `xiaowu0162/longmemeval-cleaned`), SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, 277 MB. 500 questions, 199,509 unique turns, 19,195 unique sessions. Per-question haystack: min 38, max 62, mean 47.7 sessions; all 948 answer sessions are inside their own haystack (948/948).
- **Embedders:** `Xenova/all-MiniLM-L6-v2` (384-dim, the zero-dep default) and `voyage-3-large` (1024-dim, opt-in via `config.embeddings.provider`). Both produce L2-normalized vectors; turns embedded with document role, queries with query role. 199,499 non-empty turns embedded per embedder (10 empty turns skipped; Voyage rejects empty strings).
- **Retrieval:** turn-level dense (cosine) + BM25, fused with Reciprocal Rank Fusion (k=60), max-pooled to session. Five cells per the F9 matrix: `dense_only` (1.0 dense), `turn_sym` (0.5/0.5, turn-level BM25), `turn_asym` (0.2 BM25 / 0.8 dense), `session_sym`, `session_asym` (session-level BM25).
- **Per-haystack** (standard): candidates restricted to each question's `haystack_session_ids` (`chunk_per_turn_haystack_retrieve.mjs`). **Global-pool** (off-spec, harder): candidates = all 19,195 sessions (`chunk_per_turn_hybrid_retrieve.mjs`). Scored by `evaluate_retrieval.py` against `answer_session_ids`.

## Results

### Per-haystack `_s` (standard task) — R@K

| Embedder / cell | R@1 | R@3 | R@5 | R@10 |
|---|---|---|---|---|
| MiniLM dense_only | 85.6 | 93.8 | 96.6 | 98.6 |
| MiniLM turn_sym | 88.6 | 96.2 | 97.4 | 99.6 |
| MiniLM turn_asym | 87.6 | 96.2 | 97.6 | 99.0 |
| MiniLM session_sym | 89.6 | 96.2 | **98.6** | 99.4 |
| MiniLM session_asym | 87.8 | 95.6 | 97.8 | 99.0 |
| voyage dense_only | 93.8 | 99.2 | 99.8 | 99.8 |
| voyage turn_sym | 91.8 | 97.8 | 99.0 | 99.6 |
| voyage turn_asym | 93.6 | 99.4 | 99.8 | 99.8 |
| voyage session_sym | 93.0 | 99.0 | 99.6 | 99.6 |
| voyage session_asym | 94.6 | 99.6 | **99.8** | 99.8 |

Per-type R@5 is uniform (voyage session_asym): knowledge-update 100, multi-session 100, single-session-assistant 100, single-session-preference 100, single-session-user 100, temporal-reasoning 99.2. The MiniLM result is not driven by one easy type either.

For reference: gbrain v0.28.8 reports 97.6 R@5 on this split (per-haystack, `text-embedding-3-large` + hybrid RRF; their published figure, not re-run here).

### Global-pool `_s` (one 19,195-session store, off-spec) — R@5

| cell | MiniLM | voyage-3-large |
|---|---|---|
| dense_only | 37.8 | 44.8 |
| turn_sym | 47.2 | 56.4 |
| turn_asym | 42.2 | 50.4 |
| session_sym | 45.0 | 49.8 |
| session_asym | 41.2 | 49.0 |

Consistent with the historical F14 BGE-base global-pool R@5 = 42.0. In the global-pool regime the embedder matters more (+9.2 best-cell) but neither embedder is usable; the answer drowns among ~19k distractors.

## Dual-number summary

| `_s` regime | MiniLM (zero-dep default) | voyage-3-large (opt-in) |
|---|---|---|
| Per-haystack R@5 (standard) | 98.6 | 99.8 |
| Global-pool R@5 (19,195-session store) | 47.2 | 56.4 |

## Interpretation

- On the standard task, retrieval recall is saturated by any competent embedder; the embedder is a swappable commodity, not the differentiator. The "embedder ceiling / need F17" conclusion does not hold for standard LongMemEval-S.
- The global-pool regime (a single large unified store, no pre-scoped haystack) is closer to how an agent's memory actually accumulates, and there recall collapses for both embedders. That is the regime where the memory lifecycle (decay, consolidation, supersession) earns its keep by shrinking the effective store. Measuring that is the lifecycle stress eval (ROADMAP Part III).

## Reproduce

```bash
# embed turns (provider via config.embeddings.provider; VOYAGE_API_KEY for voyage)
node benchmarks/longmemeval/chunk_per_turn_embed_voyage.mjs --provider <local|voyage> \
  --model <Xenova/all-MiniLM-L6-v2|voyage-3-large> \
  --data data/lme_s/longmemeval_s_cleaned.json --out data/turn_index_<m>_s.json
node benchmarks/longmemeval/embed_queries_voyage.mjs --provider <...> --model <...> \
  --data data/lme_s/longmemeval_s_cleaned.json --out data/query_embeddings_<m>_s.json
node benchmarks/longmemeval/chunk_per_turn_bm25_index.mjs data/lme_s/longmemeval_s_cleaned.json data/bm25_corpus_s
# per-haystack (standard)
node benchmarks/longmemeval/chunk_per_turn_haystack_retrieve.mjs --turn-index <idx> --bm25 <corpus> \
  --data data/lme_s/longmemeval_s_cleaned.json --query-embeddings <qemb> --out <ret> --rrf-weight-bm25 0.5 --rrf-weight-dense 0.5
python benchmarks/longmemeval/evaluate_retrieval.py --retrieval <ret> --data data/lme_s/longmemeval_s_cleaned.json --output <eval>
```

Harness was run in an isolated worktree off `origin/master` (does not touch the main checkout). Voyage calls go through the v1.23.0 `EmbeddingProvider`, which validated live at 199k-turn scale.
