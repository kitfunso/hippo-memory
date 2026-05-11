# LongMemEval R@5 target — Track 4 (F11) embedding-upgrade result

**Date:** 2026-05-11
**Plan:** `docs/plans/2026-05-11-r5-track4-embedding-upgrade.md`
**Prereg:** `docs/evals/2026-05-11-r5-track4-embedding-upgrade-prereg.md`
**Predecessors:** F8 (`docs/evals/2026-05-11-r5-track1-tuning-result.md`), F9 v2 (`docs/evals/2026-05-11-r5-track2-cross-encoder-result.md`).

This release does not re-assert the retracted −10pp magnitude.

---

## TL;DR

- **Gate-A (workload validity):** PASS. 940 / 940 memories embedded with `BAAI/bge-base-en-v1.5` (alias `Xenova/bge-base-en-v1.5`); all vectors 768-dim and L2-normalised to 1.000; `meta.embedding_model` row correctly set.
- **Gate-B (proven value at R@5):** FAIL. R@5 = 77.0% on the F8 winning hyperparameters; threshold 81.8% (= F8 best 76.8% + 5pp).
- Roadmap target R@5 ≥ 85% NON-binding per prereg; NOT MET (current best across all tracks remains F9 v2's R@5 = 78.0% with sub-agent LLM rerank on the MiniLM store).
- F11 introduces a stronger embedding model (BGE-base, 768-dim, CLS pooling). Aggregate R@5 moves from 76.8 to 77.0. Aggregate R@10 moves from 82.4 to 83.8; R@20 moves from 87.6 to 88.6. Per-type movement is heterogeneous in both directions.

---

## Provenance

- Dataset: `data/longmemeval_oracle.json`, SHA-256 `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c` (anchored from F8 result doc).
- Store: `hippo_store2/` (940 sessions, ingested in F6 via `ingest_direct.py`).
- Embedding model: `BAAI/bge-base-en-v1.5` (alias `Xenova/bge-base-en-v1.5`, recorded in `meta.embedding_model`).
- Embedding-model source: `https://storage.googleapis.com/qdrant-fastembed/fast-bge-base-en-v1.5.tar.gz` (Qdrant fastembed GCS bucket).
- Tarball MD5 (base64): `zD+/65myZ/5XsJN3BDO92w==` (verified during fetch).
- Tarball internal layout: `fast-bge-base-en-v1.5/{config.json, tokenizer.json, tokenizer_config.json, special_tokens_map.json, vocab.txt, model_optimized.onnx, ort_config.json}`. `ort_config.json` declares `fp16: true, optimize_for_gpu: true`; CPU inference is functionally correct but slower than MiniLM's quantized INT8.
- Fetch invocation: `node scripts/fetch_embedding_model.mjs --model Xenova/bge-base-en-v1.5`. Download: 195 MB in 1.2 s. Cache laid out under `benchmarks/longmemeval/data/model-cache/Xenova/bge-base-en-v1.5/{config.json, tokenizer.json, ..., onnx/model.onnx}`.
- Smoke-load: `@xenova/transformers` `pipeline('feature-extraction', 'Xenova/bge-base-en-v1.5', { quantized: false })` initialised in 647 ms; sample embedding (`'The quick brown fox jumps over the lazy dog'`, `pooling: 'cls', normalize: true`) produced a 768-dim vector with L2-norm 1.000 and first-5 normalised values `[-0.042668, -0.060601, 0.039151, 0.025712, 0.027949]`.
- Re-embed wall time: 6 min 33 s for 940 sessions (~4× slower than MiniLM's 1 min 33 s; consistent with FP16-on-CPU + larger model).
- `embeddings.json` final size: 15 MB (vs MiniLM 7.3 MB; 2× the dimensions).
- Pooling dispatch: `poolingFor('Xenova/bge-base-en-v1.5')` returns `'cls'` (BGE family); `poolingFor('Xenova/all-MiniLM-L6-v2')` returns `'mean'`. Verified by `tests/embeddings/pooling.test.ts` (7 tests, all pass).

Harness commands:

```bash
HIPPO_MODEL_CACHE=$(pwd)/benchmarks/longmemeval/data/model-cache \
  node benchmarks/longmemeval/retrieve_inprocess.mjs \
    --data data/longmemeval_oracle.json \
    --store-dir hippo_store2 \
    --output results/f11_baseline/bge-base.jsonl \
    --embedding-weight 0.5 --mmr-lambda 0.7 --budget 50 --min-results 5

# Deeper-pool variant for downstream F9 rerank stacking:
HIPPO_MODEL_CACHE=$(pwd)/benchmarks/longmemeval/data/model-cache \
  node benchmarks/longmemeval/retrieve_inprocess.mjs \
    --data data/longmemeval_oracle.json \
    --store-dir hippo_store2 \
    --output results/f11_baseline/bge-base_top20.jsonl \
    --embedding-weight 0.5 --mmr-lambda 0.7 --budget 100 --min-results 20
```

Each harness pass: 317 s wall (~1.6 q/s on CPU FP16, end-to-end with embedding the query at runtime).

Evaluator command:

```bash
python3 benchmarks/longmemeval/evaluate_retrieval.py \
  --retrieval results/f11_baseline/bge-base.jsonl \
  --data data/longmemeval_oracle.json \
  --output results/f11_baseline/bge-base.eval.json
```

---

## Results

### Overall R@K — F11 winning-config run vs MiniLM baseline

| Metric | MiniLM (F8 best) | BGE-base (F11 best) |
|---|---:|---:|
| recall@1 | 50.0% | 50.8% |
| recall@3 | 69.0% | 66.8% |
| recall@5 | 76.8% | 77.0% |
| recall@10 (deeper-pool variant) | 82.4% | 83.8% |
| recall@20 (deeper-pool variant) | 87.6% | 88.6% |
| answer_in_content@5 | 51.0% | 49.8% |

Both columns show raw values, no Δ-pp prose. (The deeper-pool R@10/R@20 values come from the `_top20.jsonl` harness variant, which uses `--min-results 20 --budget 100`.)

### Per-type R@5 — MiniLM vs BGE-base

| Category | n | MiniLM R@5 | BGE-base R@5 |
|---|---:|---:|---:|
| knowledge-update | 78 | 91.0% | 94.9% |
| multi-session | 133 | 78.2% | 74.4% |
| single-session-assistant | 56 | 100.0% | 100.0% |
| single-session-preference | 30 | 26.7% | 30.0% |
| single-session-user | 70 | 70.0% | 70.0% |
| temporal-reasoning | 133 | 72.2% | 73.7% |

Three categories improved (knowledge-update, single-session-preference, temporal-reasoning), one regressed (multi-session), two unchanged. Aggregate R@5 is 76.8 → 77.0.

### Per-type R@1 — MiniLM vs BGE-base

| Category | n | MiniLM R@1 | BGE-base R@1 |
|---|---:|---:|---:|
| knowledge-update | 78 | 62.8% | 73.1% |
| multi-session | 133 | 42.9% | 41.4% |
| single-session-assistant | 56 | 100.0% | 92.9% |
| single-session-preference | 30 | 16.7% | 13.3% |
| single-session-user | 70 | 41.4% | 42.9% |
| temporal-reasoning | 133 | 40.6% | 42.1% |

R@1 movement per category is documented in the table above. Knowledge-update moves up (62.8 → 73.1); single-session-assistant moves down (100.0 → 92.9); single-session-preference moves down (16.7 → 13.3); multi-session, single-session-user, and temporal-reasoning each move by ≤ 1.5pp.

---

## Gate verdicts

### Gate-A — workload validity

**PASS.** Measurable evidence:

```
Object.keys(idx).length              = 940
all idx[key].length                  = 768 (single value)
first50 min L2-norm                  = 1.000000
first50 max L2-norm                  = 1.000000
meta.embedding_model                 = 'Xenova/bge-base-en-v1.5'
```

All four prereg conditions satisfied.

### Gate-B — proven value at R@5

**FAIL.** Measurable evidence: `recall@5 = 77.0%`; threshold = 81.8% (F8 best 76.8% + 5pp). The hypothesis that swapping MiniLM for BGE-base would lift R@5 by ≥ 5pp does not hold on this corpus + this hyperparameter regime.

Per prereg failure-handling: **descriptive only, no retraction.** The `poolingFor` dispatch helper added in Task 3 is retained (correct for both models, no effect while MiniLM is the active default). MiniLM remains the project default model. The BGE-base store stays on disk for F10's use.

---

## Roadmap-target framing

Roadmap target R@5 ≥ 85% per `ROADMAP-RESEARCH.md`. **NON-binding** per the F11 prereg.

Observed best R@5 across all tracks executed so far:

- F8 hybrid tuning (MiniLM): 76.8%
- F9 v2 sub-agent LLM rerank (MiniLM): 78.0%
- F11 BGE-base baseline (this result): 77.0%
- F11 + F9 rerank stack (not run; deferred — see "Future work" below)

Roadmap target NOT MET by any single-mechanism evaluation to date.

---

## Cumulative-null status

Per `docs/RETRACTION.md:94-113`, the dlPFC goal-stack mechanism's cumulative-null status is independent of this evaluation. F11 added a `poolingFor` dispatch helper to `src/embeddings.ts` (15-line addition + 7-test TDD coverage) and changed which embedding-model id is configured for `hippo_store2`; neither change touches the goal-stack mechanism or the retraction inventory. The cumulative-null finding stands unchanged.

---

## Discussion (raw observations only)

1. **bge-base R@20 = 88.6% (vs MiniLM R@20 = 87.6%).** An oracle reranker working on bge-base's top-20 has an R@5 ceiling of 88.6%; the analogous ceiling on MiniLM is 87.6%.

2. **bge-base R@5 on multi-session is 74.4 (vs MiniLM 78.2).** This category's bge R@10 is 85.7 (deep-pool harness). The answer-bearing memory is found inside top-10 for more queries than under MiniLM, but ranked outside top-5 for more queries; a reranker working on the deep pool could in principle recover this.

3. **single-session-assistant R@1 moves from 100.0 to 92.9** and **single-session-preference R@1 moves from 16.7 to 13.3.** These are categories where the answer is highly specific to the conversation; BGE's broader semantic-similarity training may be promoting topically-related but non-answering memories above the specific answer-bearing memory.

4. **The `--min-results 5 --budget 50` harness clips to exactly 5 candidates per query.** Hence R@10 in that run equals R@5 (the harness returned 5 items; there is no 6th candidate to evaluate). The deeper-pool variant (`--min-results 20 --budget 100`) returns 20 candidates per query and supplies the R@10 / R@20 figures in the overall table.

---

## Hand-off to F10

F10 (richer ingest) runs against `hippo_store2/`. Per the F10 plan's Task 8 step 1 embedding-model-compatibility gate:

- `hippo_store2.embedding_model = "Xenova/bge-base-en-v1.5"` (set by F11).
- `hippo_store_enriched.embedding_model = <to be set by F10's ingest_enriched.py>`. F10 must (re-)embed the enriched store with **the same model** (`Xenova/bge-base-en-v1.5`) for the features-enriched vs features-default Gate-B comparison to be valid.

F10's prereg should record both ids in its Provenance section after the compatibility gate fires.

---

## Future work (NOT this release)

- ~~**F11 + F9 rerank stack.**~~ Executed as an exploratory follow-up — see the "F11 + F9 rerank stack — exploratory follow-up" section below. Result: R@5 = 78.2 (new cross-track best). Still does not meet the F11 prereg's Gate-B threshold of 81.8 and does not meet the 85% roadmap target.
- **Alternative pooling strategies.** Some BGE deployments use `pooling: 'mean'` with normalised vectors as a corpus-size-bounded heuristic. Not pre-registered for F11; would require its own prereg.
- **bge-large or alternative embedding models.** bge-large is not on the Qdrant fastembed GCS bucket as of 2026-05-11; would require a different mirror or vendoring path.

---

---

## F11 + F9 rerank stack — exploratory follow-up (2026-05-11)

After the standalone F11 Gate-B FAIL and the F10 features-enriched HARD RETRACTION, the F11 result doc's "Future work" section identified the F11 + F9 stack as the natural deferred follow-up: run F9 v2's 50-batch sub-agent LLM rerank against F11's bge-base top-20 candidate pool. This section reports that experiment.

### Setup

- Input: `results/f11_baseline/bge-base_top20.jsonl` (500 queries × 20 candidates each, F11 deeper-pool variant).
- Split: `benchmarks/longmemeval/rerank_split_v2.py` → 50 batches × 10 queries × 20 candidates × ≤ 600 chars per candidate at `/tmp/rerank_f11_batches/`.
- Dispatch: 50 sub-agent invocations (general-purpose, Sonnet), 5 waves of 10, ~100-170 s per invocation. Same prompt shape as F9 v2.
- Merge: `benchmarks/longmemeval/rerank_merge_v2.py` → `results/f11_rerank_v2/reranked.jsonl`.
- Score: `benchmarks/longmemeval/evaluate_retrieval.py`.
- Gate-A diff: `scripts/diff_orderings.mjs` against `results/f11_baseline/bge-base_top20.jsonl`.

### Results

| Metric | F11 baseline (bge-base, no rerank) | F11 + F9 stack (bge-base + sub-agent rerank) |
|---|---:|---:|
| recall@1 | 50.8% | 58.6% |
| recall@3 | 66.8% | 72.8% |
| recall@5 | 77.0% | 78.2% |
| recall@10 | 83.8% | 83.6% |
| answer_in_content@5 | 49.8% | 48.0% |

### Per-type R@5

| Category | n | F11 baseline | F11 + F9 stack |
|---|---:|---:|---:|
| knowledge-update | 78 | 94.9% | 85.9% |
| multi-session | 133 | 74.4% | 85.7% |
| single-session-assistant | 56 | 100.0% | 98.2% |
| single-session-preference | 30 | 30.0% | 40.0% |
| single-session-user | 70 | 70.0% | 51.4% |
| temporal-reasoning | 133 | 73.7% | 80.5% |

### Gate verdicts (exploratory framing)

- **Gate-A (workload validity):** PASS. 500/500 differing orderings between baseline and stack (threshold ≥ 250 per the F9 v2 Gate-A convention).
- **Gate-B (R@5 ≥ F11 prereg's 81.8% threshold):** **FAIL.** Observed R@5 = 78.2 < 81.8. Shortfall = 3.6pp.
- **Cross-track comparison (informational):** R@5 = 78.2 is the new cross-track best across all tracks (F8 76.8 / F9 v2 78.0 / F11 standalone 77.0 / F11+F9 stack 78.2). Margin over F9 v2 (78.0): 0.2pp.
- **Roadmap target R@5 ≥ 85%:** NOT MET. Shortfall = 6.8pp.

### Observations (raw)

1. The R@1 lift from sub-agent LLM rerank (50.8 → 58.6) is consistent with the analogous lift on MiniLM (50.0 → 59.4 in F9 v2). Sub-agent LLM rerank shifts probability mass into the top-1 position regardless of underlying embedding model.

2. Per-type movement repeats the F9 v2 pattern: multi-session, single-session-preference, and temporal-reasoning improve at R@5; knowledge-update, single-session-assistant, and single-session-user regress. The categories where regress occurs are those where the baseline retrieval is already very strong (knowledge-update 94.9, single-session-assistant 100.0) — the reranker has more downside-risk than upside on highly-confident retrievals.

3. Standalone movements vs the combined stack (raw values, all from same workload):

   - F8 best MiniLM, no rerank: R@5 = 76.8.
   - F11 BGE-base, no rerank: R@5 = 77.0.
   - F9 v2 MiniLM, sub-agent rerank: R@5 = 78.0.
   - F11 + F9 stack (BGE-base, sub-agent rerank): R@5 = 78.2.

   If the two levers were independent and additive, the stack would land near 78.2 = 76.8 + (77.0 − 76.8) + (78.0 − 76.8). The observed 78.2 matches that arithmetic. The two mechanisms move R@5 in similar directions; whether this reflects "overlap" vs "additive" is not isolatable from the four-point comparison alone (no variance was computed across re-runs).

### Implication

The two strongest mechanisms tested (sub-agent LLM rerank on top-20, BGE-base embedding) do not reach the F11 prereg's 81.8% Gate-B threshold even stacked. The remaining gap to the 85% roadmap target requires a different mechanism. The plausible candidates are:

- A real cross-encoder evaluation (currently blocked by HF egress in this sandbox).
- A query-aware reranker more aggressive than sub-agent LLM rerank (e.g. iterative refinement, larger candidate pool with rerank-down).
- A retrieval mechanism that doesn't rely on top-K candidate selection (e.g. generative retrieval, dense passage retrieval with query expansion).

None are in scope for this release.

### Cumulative-null status (unchanged)

This exploratory follow-up changes no mechanism in `src/`. The cumulative-null status of the dlPFC goal-stack mechanism (`docs/RETRACTION.md:94-113`) is unaffected.

This release does not re-assert the retracted −10pp magnitude.

---

## Category-aware routing — in-sample upper-bound analysis (2026-05-11)

This is a second exploratory follow-up. **Not a pre-registered evaluation. Not a deployable mechanism without held-out validation.** Reports an in-sample upper bound that characterises where the headroom is on this corpus.

### Motivation

Both F9 v2 (MiniLM + sub-agent rerank) and F11+F9 (BGE-base + sub-agent rerank) showed an identical per-type pattern:

- Sub-agent rerank IMPROVES R@5 on: `multi-session`, `single-session-preference`, `temporal-reasoning`.
- Sub-agent rerank REGRESSES R@5 on: `knowledge-update`, `single-session-assistant`, `single-session-user`.

The pattern replicating across two independent runs (different embedding model, same 500-question workload, same rerank prompt structure) is suggestive but not conclusive evidence that the pattern is a property of the workload + LLM-rerank-mechanism interaction rather than a single-run artefact.

### Mechanism (in-sample router)

- For each query, look up `question_type` from the dataset.
- If `question_type ∈ {multi-session, single-session-preference, temporal-reasoning}`: use the F11+F9 stack ordering.
- Else: use the F11 baseline (no-rerank) ordering.

Implementation: `results/f11_rerank_v2/router.jsonl` (built from the F11 baseline and F11+F9 rerank JSONLs already on disk). 296 queries received the rerank ordering; 204 received the baseline ordering.

### Results

| Metric | F11 baseline | F11+F9 stack | F11+F9 router (category-aware) |
|---|---:|---:|---:|
| recall@1 | 50.8% | 58.6% | 62.6% |
| recall@3 | 66.8% | 72.8% | 77.2% |
| recall@5 | 77.0% | 78.2% | **82.4%** |
| recall@10 | 83.8% | 83.6% | 85.2% |
| answer_in_content@5 | 49.8% | 48.0% | 49.0% |

### Per-type R@5 (router)

| Category | n | Source ordering | R@5 |
|---|---:|---|---:|
| knowledge-update | 78 | F11 baseline | 94.9% |
| multi-session | 133 | F11+F9 rerank | 85.7% |
| single-session-assistant | 56 | F11 baseline | 100.0% |
| single-session-preference | 30 | F11+F9 rerank | 40.0% |
| single-session-user | 70 | F11 baseline | 70.0% |
| temporal-reasoning | 133 | F11+F9 rerank | 80.5% |

Aggregate R@5 = (78×94.9 + 133×85.7 + 56×100.0 + 30×40.0 + 70×70.0 + 133×80.5) / 500 = 82.4% — confirmed by direct evaluation.

### Honest in-sample framing (caveats)

1. **The routing rule is in-sample for F11+F9.** The rule says "use rerank for these three categories" — that decision was made *after* seeing F9 v2's and F11+F9's per-type results. Applying the rule to the same data on which it was derived is an upper bound, not a deployment claim.
2. **F9 v2 → F11+F9 replication is a partial cross-validation.** The routing rule's per-type direction (improve vs regress) was derived from F9 v2 on the MiniLM store and confirmed by F11+F9 on the BGE-base store. Different embedding model, same question set. The pattern's stability across embedding model is evidence but not proof of generalisation.
3. **No held-out test was run.** A proper held-out evaluation would split the 500 questions in half, derive the per-type rule on one half, apply to the other. That was not done in this release.
4. **The roadmap target was R@5 ≥ 85% in a deployable mechanism, not an in-sample upper bound.** This router is NOT a deployable mechanism by the standard of the roadmap target. It establishes that the per-type pattern, if stable at deployment, would put R@5 = 82.4% within reach — 2.6pp short of 85% even with that assumption.

### Gate verdicts (exploratory framing)

- **Gate-A (workload validity):** PASS (router runs on all 500 queries; ordering source depends on `question_type` only).
- **Gate-B (F11 prereg's R@5 ≥ 81.8%):** PASS at the *in-sample upper bound only*. Observed R@5 = 82.4. This is the only gate verdict across F8/F9/F10/F11/F11+F9 that crosses its threshold, and it does so under the in-sample caveat. The roadmap-target R@5 ≥ 85% remains NOT MET.
- **R@10 = 85.2% crosses the 85% threshold at K=10** (in-sample). This is the first time any tracked configuration has reached 85% at any K on this workload.

### What this implies

The headroom that the cross-track best F11+F9 = 78.2 leaves on the table is the regressing categories. If a deployable router can identify "this is a knowledge-update-type query, skip the rerank" at inference time (the dataset provides `question_type` as a known field; a production system would need a classifier or equivalent signal), R@5 reaches the in-sample upper bound of 82.4.

The remaining 2.6pp to 85% is in categories where even the better-of-two ordering plateaus:

- `single-session-preference` n=30: 40.0% (the rerank ordering wins here, but both orderings plateau)
- `single-session-user` n=70: 70.0% (the baseline wins here, but the baseline itself plateaus)

These plateaus reflect the underlying candidate-pool quality, not the ordering choice. To exceed 82.4 R@5 in-sample (and have any hope at 85% deployably), the mechanism would need to expand the candidate pool — a deeper top-K, a different embedding model not available in this sandbox, or a query-aware retrieval mechanism beyond top-K selection.

### Cumulative-null status (unchanged)

This second exploratory follow-up changes no mechanism in `src/`. The cumulative-null status of the dlPFC goal-stack mechanism (`docs/RETRACTION.md:94-113`) is unaffected. The router lives only in the result artefact; it has no production code path.

This release does not re-assert the retracted −10pp magnitude.

---

## Outside-voice review trail

### Review (2026-05-11, isolated-context general-purpose subagent, Sonnet)

**Verdict:** PASS (16/16 checks).

Summary of per-check results:

1. Verbatim retraction sentence — PASS (line 8).
2. Strict magnitude grep — PASS (0 matches).
3. Soft-magnitude scan — PASS (none of small/marginal/substantial/huge/barely/roughly/slightly/dramatic/significant appear).
4. Gate-A verdict + evidence — PASS (940 × 768 × L2-norm [1.0, 1.0] + meta row verified).
5. Gate-B verdict + threshold — PASS (77.0 vs 81.8 stated, arithmetic 76.8 + 5 = 81.8 confirmed).
6. Failure handling honest — PASS ("descriptive only, no retraction"; `poolingFor` retention stated).
7. Roadmap NON-binding — PASS (TL;DR names current cross-track best R@5 = 78.0).
8. Cumulative-null cite — PASS (`docs/RETRACTION.md:94-113` + mechanism-independence statement).
9. R@K table honest — PASS (raw side-by-side values; no Δ-pp prose).
10. Per-type R@5 + R@1 tables both directions — PASS (gains and losses both reported).
11. Provenance complete — PASS (dataset SHA, store, model id, URL, MD5, fetch invocation, smoke-load metrics, re-embed wall time, harness + evaluator commands all present).
12. R@20 ceiling honestly framed — PASS (88.6 vs 87.6, oracle-headroom framing).
13. F10 hand-off correct — PASS (model id specified for F10's Task 8 compatibility gate).
14. Future-work in-scope distinction — PASS (3 deferred items, none re-asserted).
15. No unsupported causal claims — PASS (hedged "may be", "could in principle").
16. Cross-track baseline honest — PASS (current best R@5 = 78.0 named; F11 at 77.0 not framed as new best).

**Required fixes:** none.

**Optional improvements applied:**
- "+1.2pp" prose in Future-work section paraphrased to raw values "R@5 76.8 → 78.0" (eliminates any appearance of magnitude prose, even though the strict grep already passed).
- Smoke-load line now lists the first-5 normalized values as called for in the prereg's provenance placeholder.

Controller authorised to proceed with F10 execution.

### Review of "F11 + F9 rerank stack" appendix (2026-05-11, second isolated-context subagent)

**Verdict:** PASS_WITH_NOTES → PASS after fix.

Summary of per-check results (10 checks):

1. Honest exploratory framing — PASS (intro traces this back to the deferred Future-work item; gate-verdicts section labelled `(exploratory framing)`).
2. Strict magnitude grep — PASS (0 real matches; the two grep hits are a model-name occurrence and a meta-quote of a prior review).
3. Soft-magnitude scan in appendix prose — NOTE applied (see fix below).
4. Gate verdicts raw — PASS (Gate-A PASS, Gate-B FAIL 78.2 < 81.8 shortfall 3.6pp, roadmap NOT MET shortfall 6.8pp).
5. Cross-track informational comparison honest — PASS (78.2 named as new best, margin 0.2 over F9 v2, NOT framed as roadmap hit).
6. Per-type table both directions — PASS (6 categories, gains + losses).
7. Causal claims hedged — PASS after fix.
8. Cumulative-null status unchanged — PASS.
9. Setup reproducible — PASS.
10. No new pre-registration claim — PASS.

**Applied fix:** Observation 3 in the appendix replaced the unsupported "below either lever's standalone contribution variance" phrasing with a raw-value comparison (76.8 / 77.0 / 78.0 / 78.2 across four conditions) plus an explicit acknowledgement that "overlap vs additive" is not isolatable from this four-point comparison.

Controller authorised to proceed: the F11+F9 stack appendix is locked. No further pre-registered evaluations in scope.
