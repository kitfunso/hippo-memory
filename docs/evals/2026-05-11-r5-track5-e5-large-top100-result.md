# LongMemEval R@5 target — Track 5 (F12) e5-large + top-100 — result

**Date:** 2026-05-11
**Author:** controller (claude/plan-implementation-workflow-sasNp)
**Plan / Prereg:** `docs/evals/2026-05-11-r5-track5-e5-large-top100-prereg.md`
**Predecessors:** F11 (BGE-base, oracle R@5 = 77.0%, Gate-B FAIL on 81.8 threshold); F11+F9 stack (oracle R@5 = 78.2%, current deployable best).

This release does not re-assert the retracted −10pp magnitude.

---

## Split-mismatch disclosure (binding, per prereg)

**This track measures `data/longmemeval_oracle.json` (3 sessions per haystack, the easy split). gbrain v0.28.8 measured `_s` (50 sessions per haystack, the standard split).** Numbers in this doc are NOT directly comparable to gbrain's 97.60 % R@5 figure. The per-embedder comparison is also non-applicable: gbrain uses `text-embedding-3-large@1536` (OpenAI hosted, paid API), F12 uses `intfloat/multilingual-e5-large` (1024-dim local). The only honest comparison is F12 against our own F11+F9 stack baseline of 78.2 % oracle R@5.

## TL;DR

- **Gate-A:** PASS. 940 sessions re-embedded with `intfloat/multilingual-e5-large` (1024-dim, mean pooling, "query: " / "passage: " prefix dispatch). All L2-norms in [0.9999, 1.0001]. Re-embed wall: 1292.4 s.
- **Gate-B:** **FAIL**. F12 best variant R@5 = 78.8 % (F12 + F9 sub-agent rerank on top-20). Threshold was ≥ 83.2 %. Shortfall: 4.4 percentage points.
- Per the F12 prereg, Gate-B FAIL triggers HARD RETRACTION. The embedding-model swap reverts on disk: `hippo_store2/` is restored to the BGE-base index and `meta.embedding_model` reads `Xenova/bge-base-en-v1.5`. CHANGELOG, README, and ROADMAP are NOT updated with F12 numbers; the project's deployable cross-track best remains F11+F9's R@5 = 78.2.
- Code paths that gate on model id (`poolingFor`, `prefixFor`, `preferredBackend`) stay in `src/` because each is a pure dispatch helper that returns the legacy behavior for non-e5 models — keeping them avoids re-adding a deletion+re-add cycle if a future track tries a different model from the same Qdrant mirror.
- Roadmap target R@5 ≥ 85 % is NON-binding per prereg. Not met. gbrain v0.28.8's 97.60 figure is on a different split (`_s`, 50 distractors per haystack) and a different embedder (`text-embedding-3-large@1536`); the per-split AND per-embedder mismatch is documented in the split-mismatch disclosure above.


## Provenance

- **Dataset:** `data/longmemeval_oracle.json`, SHA-256 `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c` (anchored from F8 / F11 result docs).
- **Store:** `hippo_store2/` (940 sessions, ingested in F6).
- **Embedding model:** `intfloat/multilingual-e5-large` via alias `Xenova/multilingual-e5-large`.
- **Embedding-model source:** `https://storage.googleapis.com/qdrant-fastembed/fast-multilingual-e5-large.tar.gz` (1.25 GiB tarball; MD5 `qfG9AF6uyVOG9RgHd1XpLA==` base64 / `a9f1bd005eaec95386f518077755e92c` hex; stored size 1,311,120,679 bytes, matches GCS `x-goog-stored-content-length`).
- **Fetch script:** `node scripts/fetch_embedding_model.mjs --model Xenova/multilingual-e5-large`.
- **Backend dispatch:** `@huggingface/transformers` v4 (added as an optional dep; the older `@xenova/transformers` v2.17 cannot load ONNX external-data correctly — see "Implementation note" below).
- **Re-embed driver:** `embedAll(hippo_store2/.hippo)` via `dist/embeddings.js`, with `HIPPO_MODEL_CACHE` pointed at the local model-cache dir.
- **Retrieval harness:** `node benchmarks/longmemeval/retrieve_inprocess.mjs --data data/longmemeval_oracle.json --store-dir hippo_store2 --output results/f12_baseline/e5-large_top100.jsonl --embedding-weight 0.5 --mmr-lambda 0.7 --budget 200 --min-results 100`.
- **Evaluator:** `python3 benchmarks/longmemeval/evaluate_retrieval.py --retrieval results/f12_baseline/e5-large_top100.jsonl --data data/longmemeval_oracle.json --output results/f12_baseline/e5-large_top100.eval.json`.

## Gate-A — workload validity

**Verdict: PASS.**

Measurement (one-liner output, see `scripts/fetch_embedding_model.mjs` and the embed driver section above):

```json
{
  "count": 940,
  "dims": [1024],
  "minNorm": 0.9999995564238982,
  "maxNorm": 1.000000513233746
}
meta.embedding_model: Xenova/multilingual-e5-large
```

All five conditions met:

- Key count: 940 (PASS).
- Vector dimension: 1024 (PASS — matches `intfloat/multilingual-e5-large` `hidden_size`).
- L2-norm spot-check (first 50 keys): all in [0.999, 1.001] (PASS — observed [0.9999995, 1.0000005]).
- `meta.embedding_model` row: `Xenova/multilingual-e5-large` (PASS).
- Prefix-routing smoke: a query/passage pair on the same input string produced cosine ≠ 1 (observed 0.9281, see smoke output in the implementation notes), confirming the e5 prefix path is engaged.

Re-embed wall time: **1292.4 s** (≈ 21.5 min for 940 sessions on CPU via `@huggingface/transformers` + onnxruntime-node, 4-core sustained). Final `embeddings.json` size: 20,371,057 bytes (≈ 19.4 MiB; up from BGE-base's 14.5 MiB, scaling with the 1024/768 = 1.33× dim ratio plus FP32 string-encoding overhead).

## Gate-B — proven value at R@5

**Verdict: FAIL.** F12 best variant R@5 = 78.8 % (F12 + F9 stack). Threshold was ≥ 83.2 %. **Shortfall: 4.4 pp.**

Per the F12 prereg, this triggers **HARD RETRACTION** (see retraction section below).

Comparison vs the F11+F9 baseline (the prior deployable cross-track best):

| Configuration | R@1 | R@3 | R@5 | R@10 | R@20 |
|---|---:|---:|---:|---:|---:|
| F11+F9 stack (prior deployable, BGE-base) | (see F11 result doc) | — | 78.2 | — | — |
| F12 baseline (e5-large hybrid, top-100) | 51.6 | 68.6 | 78.0 | 83.2 | 89.2 |
| **F12 + F9 stack (e5-large + sub-agent rerank, top-20)** | **62.0** | **74.2** | **78.8** | **84.6** | **90.0** |
| Gate-B threshold | — | — | 83.2 | — | — |

The F12 + F9 stack is the new cross-track best on the oracle split at R@5 (margin over F11+F9: +0.6 raw R@5 points). The lift is real but well below the Gate-B threshold of 83.2; the stack does not capture enough of the 11.2-point headroom that the e5-large top-20 candidate pool exposed (R@20 = 89.2 vs R@5 = 78.0).

## Per-K table

Full distribution from F12's deep-pool retrieval (top-100 candidates per query):

| K | F12 baseline R@K | F12 + F9 stack R@K |
|---:|---:|---:|
| 1 | 51.6 | 62.0 |
| 3 | 68.6 | 74.2 |
| 5 | 78.0 | 78.8 |
| 10 | 83.2 | 84.6 |
| 20 | 89.2 | 90.0 |
| 50 | 94.2 | (n/a — rerank only touches top-20) |
| 100 | 97.4 | (n/a — rerank only touches top-20) |

**Reranker ceiling on top-20 = 89.2**; the F9 stack reaches R@5 = 78.8, capturing 0.8 / 11.2 = 7 % of the available headroom. Pattern repeats from F11+F9 (R@5 = 78.2 vs R@20 ceiling 88.6 — captured 1.2 / 11.6 ≈ 10 %).

## Per-type breakdown

F12 + F9 stack at R@5:

| question_type | n | R@5 |
|---|---:|---:|
| knowledge-update | 78 | 85.9 |
| multi-session | 133 | 89.5 |
| single-session-assistant | 56 | 96.4 |
| single-session-preference | 30 | 43.3 |
| single-session-user | 70 | 50.0 |
| temporal-reasoning | 133 | 79.7 |
| **all types** | **500** | **78.8** |

Compare to F12 baseline at R@5 (no rerank):

| question_type | F12 baseline | F12 + F9 stack | direction |
|---|---:|---:|---:|
| knowledge-update | 93.6 | 85.9 | reranker regresses on a strong baseline (same pattern as F11+F9 / F9 v2) |
| multi-session | 75.9 | 89.5 | reranker lifts the hardest category |
| single-session-assistant | 100.0 | 96.4 | reranker regresses (ceiling already saturated) |
| single-session-preference | 26.7 | 43.3 | reranker lifts |
| single-session-user | 71.4 | 50.0 | reranker regresses |
| temporal-reasoning | 76.7 | 79.7 | reranker lifts |

The "rerank-regresses-on-strong-baseline" pattern from F9 v2 / F11+F9 reproduces on F12. The lift on the hardest categories (multi-session, preference, temporal) is roughly balanced by regressions where the baseline was already near ceiling. Net at the aggregate level: +0.8 pp.

## F12 + F9 per-type rerank stack

Procedure (matches F9 v2 / F11+F9):

- Retrieve top-100 candidates per query → `results/f12_baseline/e5-large_top100.jsonl`.
- Split: `benchmarks/longmemeval/rerank_split_v2.py` → 50 batches × 10 queries × 20 candidates × ≤ 600 chars per candidate at `/tmp/rerank_f12_batches/`.
- Rerank: 50 sub-agent dispatches (general-purpose, Sonnet 4.6, controller-driven, dispatched in 5 waves of 10 parallel). Each sub-agent read its batch, ranked all 20 candidates per query by relevance to the question, and wrote `ranked_ids` to `/tmp/rerank_f12_outputs/batch_NNN.json`.
- Merge: `benchmarks/longmemeval/rerank_merge_v2.py` → `results/f12_rerank/reranked.jsonl`.
- One batch (026) returned malformed JSON (trailing `}}]` instead of `}]`); manual one-character fix applied before merge. All 50 batches × 10 queries = 500 valid rerank outputs in the merge.

## HARD RETRACTION (executed)

Per the F12 prereg's binding Gate-B FAIL arm, the following reverts are applied:

1. **Store revert.** `hippo_store2/.hippo/embeddings.json` is restored from the snapshot `hippo_store2/.hippo/embeddings.bge-base.json.bak` (940 × 768 vectors, the BGE-base index from F11). `hippo_store2/.hippo/config.json` is restored to `{"embeddings": {"model": "Xenova/bge-base-en-v1.5"}}`. The `meta.embedding_model` row in `hippo_store2/.hippo/hippo.db` is rewritten to `Xenova/bge-base-en-v1.5`. After revert, the store is byte-identical to its F11-end state.

2. **Code-path revert scope (per prereg dispatch-shape carve-out).** `prefixFor(model, role)` and `preferredBackend(model)` are pure dispatch helpers that return the legacy behavior (`''` and `'xenova'`) for non-e5 models. Per the prereg, dispatch helpers of this shape are safe to leave in `src/embeddings.ts`. They stay. The `'passage'` / `'query'` role parameter on `getEmbedding` and its two call sites in `src/search.ts` also stay — for BGE-base (the restored default) `prefixFor` is empty and the call is a no-op.

3. **CLI / README.** `benchmarks/longmemeval/retrieve_inprocess.mjs --min-results` flag stays as a flag (default unchanged). No public-facing default to revert; the README's recommended invocations for the LongMemEval harness are unchanged from F11. `benchmarks/longmemeval/README.md` was not modified in this track. Diff-check attestation (per prereg "A README diff check is required before the retraction commit lands"): `git diff HEAD -- benchmarks/longmemeval/README.md` produced no output before the retraction commit.

4. **Vendored model.** The 2.1 GiB on-disk `multilingual-e5-large` weights at `benchmarks/longmemeval/data/model-cache/Xenova/multilingual-e5-large/` are gitignored (matching the pattern used for `Xenova/bge-base-en-v1.5/` and `Xenova/all-MiniLM-L6-v2/`). They stay on disk for any future track that wants to retry under a different gate; nothing committed to the repo references them as the production embedding model.

5. **Docs not updated.** CHANGELOG, README, ROADMAP, and `docs/RETRACTION.md` are NOT updated to cite F12 numbers. Per the prereg, the project's deployable cross-track best remains the F11+F9 stack's R@5 = 78.2 on the oracle split. The roadmap target R@5 ≥ 85 % is still NOT MET in any deployable form. The cumulative-null status of the dlPFC goal-stack mechanism (per `docs/RETRACTION.md:94-113`) is unaffected by this track.

6. **Result-doc retention.** This document is retained as the negative-result record. Per the broader retraction discipline (and matching F10's pattern), negative-result documents stay published to maintain the audit trail; they are the source of truth that the corresponding claim was NOT made.

## Cross-track summary at R@5 (oracle split)

| Configuration | R@5 | Note |
|---|---:|---|
| F8 best (MiniLM hybrid) | 76.8 | F8 result doc |
| F9 v2 (MiniLM + sub-agent rerank) | 78.0 | F9 v2 result doc |
| F11 (BGE-base baseline) | 77.0 | F11 Gate-B FAIL (81.8 threshold) |
| F11 + F9 stack (BGE + sub-agent rerank) | **78.2** | **deployable cross-track best (UNCHANGED after this track)** |
| F12 (e5-large baseline) | 78.0 | this track |
| F12 + F9 stack (e5-large + sub-agent rerank) | 78.8 | this track — Gate-B FAIL → HARD RETRACTION |
| F11 + F9 + category-aware router | 82.4 | F11 result appendix, in-sample upper bound only |
| **F12 prereg Gate-B threshold** | **83.2** | = 78.2 + 5pp |
| Roadmap stretch (NON-binding) | 85.0 | NOT MET in any deployable form |
| gbrain v0.28.8 hybrid (different split + embedder) | 97.60 on `_s` | NOT directly comparable — see split-mismatch disclosure |

## Implementation note: ONNX external-data and backend dispatch

`multilingual-e5-large`'s Qdrant fastembed tarball ships ONNX in external-data format: a 546 KB `model.onnx` graph that references a 2.2 GB `model.onnx_data` sidecar. `@xenova/transformers` v2.17 (the historical peer dep) loads the .onnx as an in-memory `Buffer` before handing it to `onnxruntime`, which severs the external-data path resolution and produces:

```
Exception during initialization: Initializer model_path must not be empty.
```

The maintained fork `@huggingface/transformers` v4 correctly passes the file path through, and the model loads in ~3.2s with a normalized 1024-dim output. F12 adds a `preferredBackend(model)` dispatch in `src/embeddings.ts` that uses the newer fork only for the e5 family (matched by `/\be5\b/i`); BGE / MiniLM continue to load via `@xenova/transformers` with no behavioral change.

This dispatch is symmetric with the existing `poolingFor(model)` and `prefixFor(model, role)` helpers — all three select the right ONNX-runtime behavior, pooling strategy, and prefix convention from the model id alone. Adding a new model family requires only an entry in `scripts/fetch_embedding_model.mjs:MODELS` and (if it differs from defaults) a branch in any of the three dispatch helpers.

## Cumulative-null acknowledgement

Per `docs/RETRACTION.md:94-113`, the dlPFC goal-stack mechanism's cumulative-null status is independent of this evaluation. F12 adds (i) a multilingual-e5-large entry to `scripts/fetch_embedding_model.mjs:MODELS`, (ii) `prefixFor(model, role)` and `preferredBackend(model)` helpers to `src/embeddings.ts`, (iii) `role` parameter threading to `getEmbedding` and its two query-side call sites in `src/search.ts`, and (iv) `@huggingface/transformers` as an optional dependency. None of these touches the goal-stack mechanism or the retraction inventory. The cumulative-null finding stands unchanged.

## Outside-voice review trail

### Review (2026-05-11, isolated-context general-purpose subagent, Sonnet)

**Verdict:** PASS_WITH_NOTES (14/14 checks PASS or PASS_WITH_NOTE).

Summary of per-check results:

1. Verbatim retraction sentence on its own line — PASS.
2. Split-mismatch disclosure binding, leads gbrain comparison, per-embedder mismatch called out — PASS.
3. Gate-A PASS verdict with measurable evidence (count 940, dims [1024], L2-norm range, meta row, prefix smoke) — PASS.
4. Gate-B FAIL arithmetic 78.8 < 83.2, shortfall 4.4pp — PASS.
5. HARD RETRACTION arm has 6 concrete revert items — PASS_WITH_NOTE (README diff attestation requested — addressed in revision).
6. Cross-track summary table consistent with prior result docs (F8 76.8 / F9 v2 78.0 / F11 77.0 / F11+F9 78.2 / router 82.4 / gbrain 97.60 on `_s`) — PASS.
7. Per-K table monotone non-decreasing — PASS.
8. Per-type breakdown sums to N=500 — PASS.
9. Cumulative-null cite `docs/RETRACTION.md:94-113` — PASS.
10. Provenance complete (dataset SHA-256, store, model id, URL, MD5, fetch script, retrieval / evaluator commands, wall time, file size) — PASS_WITH_NOTE (20-byte stored-size discrepancy with prereg flagged — addressed in revision).
11. Magnitude-smuggling grep returns 0 matches — PASS.
12. Roadmap target NON-binding and NOT MET — PASS.
13. Implementation note on ONNX external-data + backend dispatch accurate (xenova v2.17 buffer vs file path; @huggingface v4 fix; `/\be5\b/i` dispatch; three-helper symmetry) — PASS.
14. Free-form: 20-byte size discrepancy, README diff attestation, duplicate `## Provenance` header flagged — addressed in revision.

**Required fixes:** none.

**Optional improvements applied (this revision):**

1. Reconciled the stored-size figure: 1,311,120,679 bytes (matches GCS `x-goog-stored-content-length` and the prereg).
2. Added README diff-check attestation to the HARD-RETRACTION arm item 3.
3. Removed the duplicate `## Provenance` header (was lines 24-26).

Controller authorised to proceed with the HARD-RETRACTION execution.
