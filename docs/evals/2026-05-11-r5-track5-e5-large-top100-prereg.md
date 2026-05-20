# LongMemEval R@5 target — Track 5 (F12) e5-large + top-100 — pre-registration

**Date:** 2026-05-11
**Predecessors:**
- F11 (BGE-base-en-v1.5 embed swap, oracle R@5 = 77.0%, Gate-B FAIL on its 81.8 threshold).
- F11+F9 stack (BGE-base + per-type rerank on top-20, oracle R@5 = 78.2%, current deployable best).
- F11 + category-aware router (oracle R@5 = 82.4%, in-sample upper bound only — not deployable).

**Motivation:** A reachable third-party reference (gbrain v0.28.8) reports `text-embedding-3-large@1536` + RRF hybrid R@5 = 97.60 % on LongMemEval `_s`. We cannot reach the `_s` split (HF Hub egress blocked; the dataset is HF-only and not committed in any mirror we've located). We can reach `multilingual-e5-large` (1024-dim, mean pooling, "query:" / "passage:" prefix convention) via the same Qdrant fastembed GCS bucket from which we vendored BGE-base. We can also widen our retrieval candidate pool from top-20 to top-100.

This release does not re-assert the retracted −10pp magnitude.

---

## Split-mismatch disclosure (binding)

**This track measures `data/longmemeval_oracle.json` (3 sessions per haystack, the easy split). gbrain measured `_s` (50 sessions per haystack, the standard split).** Any number this track produces is NOT directly comparable to gbrain's 97.60. The F12 result doc and any CHANGELOG / README mention must lead with this disclosure on its own line, before any numerical comparison sentence.

The per-model comparison is also non-applicable: gbrain uses `text-embedding-3-large@1536` (OpenAI hosted), F12 uses `intfloat/multilingual-e5-large` (1024-dim local). Per-split AND per-embedder mismatch; the only honest comparison is on whatever benchmark we score F12 on against our own prior F11+F9 stack baseline of 78.2 % oracle R@5.

The ceiling on our existing BGE-base top-20 retrieval is R@20 = 88.6 % (measured against the F11 baseline JSONL). Any reranker working on a top-20 candidate set is bounded by that ceiling. F12 widens to top-100 specifically to lift the candidate-pool ceiling.

## Goal

1. Swap embedding model from `Xenova/bge-base-en-v1.5` (768-dim, CLS pooling) to `intfloat/multilingual-e5-large` (1024-dim, mean pooling).
2. Add `e5`-prefix convention dispatch (`query: ` for queries, `passage: ` for documents) to `src/embeddings.ts`.
3. Widen LongMemEval retrieval candidate pool from `min-results=20` to top-100.
4. Re-baseline R@K, then apply F9's per-type rerank pattern on the new top-100 pool.

## Magnitude-smuggling guard

Per `docs/RETRACTION.md`. The strict grep below must return zero matches against the F12 result doc and any CHANGELOG / README mention before commit:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' <file>
```

The verbatim retraction sentence — `This release does not re-assert the retracted −10pp magnitude.` — must appear on its own line in the F12 result doc and in every commit body that touches result artefacts.

## Workload-validity gates (binding)

### Gate-A — workload validity

After vendoring multilingual-e5-large and re-embedding `hippo_store2/` with `embeddings.model = "Xenova/multilingual-e5-large"` configured:

- `Object.keys(idx).length === 940`
- For every key, `idx[key].length === 1024` (e5-large hidden size)
- For at least the first 50 keys (spot-check), `L2-norm(idx[key]) ∈ [0.999, 1.001]` (normalized output)
- `meta.embedding_model` row in `hippo_store2/.hippo/hippo.db` reads `Xenova/multilingual-e5-large` (or the `intfloat/multilingual-e5-large` canonical id; both refer to the same weights)
- Document chunks must have been embedded with the `passage: ` prefix; queries must use the `query: ` prefix at retrieval time. Both prefix paths exercised on a smoke run before re-embed begins.

PASS = all five conditions met. FAIL = any condition unmet → fix and re-run; not a retraction trigger.

### Gate-B — proven value at R@5 (binding, HARD RETRACTION on FAIL)

With the F11+F9 stack as the deployable baseline (oracle R@5 = 78.2 %), the F12 result — defined as the best of (a) e5-large + top-100 + hybrid baseline, (b) e5-large + top-100 + F9 per-type rerank — measured by `benchmarks/longmemeval/retrieve_inprocess.mjs --min-results 100` against `data/longmemeval_oracle.json` and scored by `benchmarks/longmemeval/evaluate_retrieval.py`, must be **≥ 83.2 % R@5** (= F11+F9 best 78.2 + 5pp).

PASS = `recall@5 ≥ 0.832` on whichever F12 variant is the best. If both variants ≥ 0.832, the higher of (a) and (b) is the reported result; ties broken by lower-K performance (R@1, then R@3).
**FAIL** = best F12 variant `recall@5 < 0.832` → **HARD RETRACTION**:
- Revert the embedding-model swap (BGE-base remains the project default).
- Revert any e5-prefix code in `src/embeddings.ts` if it's not behind a model-id dispatch that's safe to leave (`poolingFor` already has this property; the e5-prefix helper must follow the same dispatch shape).
- Revert the candidate-pool widening if it lifts no variant past 83.2: the `--min-results` CLI flag stays in `retrieve_inprocess.mjs` (no public-facing default to revert — the flag's default has always been the per-invocation value the controller passes), but the published recommended invocation in `benchmarks/longmemeval/README.md` reverts to `--min-results 20`. A README diff check is required before the retraction commit lands.
- The F12 result doc records the FAIL verdict, per-K and per-type numbers, and the retraction commits.
- The CHANGELOG / README / ROADMAP must NOT cite F12 numbers if Gate-B FAILs. Cumulative-null status remains the most-recent claim.

The HARD-RETRACTION arm matches F10's prereg pattern, not F11's (F11 was a config-level fallback, F12 is a stack-level claim with a substantive code path added).

### Stretch (NON-binding, NOT a target)

R@5 ≥ 85 % (roadmap F6 target per `ROADMAP-RESEARCH.md`) and R@5 > 97.60 (gbrain `_s` headline) are NON-binding in this prereg. Gate-B's 83.2 is the only binding R@5 threshold. The 97.60 figure is on a different split (see split-mismatch disclosure above) and cannot be matched apples-to-apples from this sandbox without `_s` access.

## Failure handling

- **Gate-A FAIL:** model loading, prefix routing, or embedding population is broken. Fix and re-run. Not a retraction trigger.
- **Gate-B FAIL:** **HARD RETRACTION** (see above). All F12 code changes revert; the project's deployable default remains the F11+F9 stack at 78.2 %.

## Cumulative-null acknowledgement

The F12 result doc must cite `docs/RETRACTION.md:94-113` and confirm the dlPFC goal-stack cumulative-null status is unaffected by F12. F12 introduces (i) the multilingual-e5-large model into `scripts/fetch_embedding_model.mjs`'s `MODELS` table, (ii) an e5-prefix dispatch helper in `src/embeddings.ts`, and (iii) a `--min-results 100` flag pass-through in `benchmarks/longmemeval/retrieve_inprocess.mjs`. None of these touches the dlPFC mechanism. The retraction inventory and cumulative-null escalation status documented in RETRACTION.md are independent of this evaluation.

## Outside-voice review

This prereg is dispatched for a fresh isolated-context review (per F8 / F9 / F11 convention) before Task 1 (model fetch) begins. The result doc will undergo a separate outside-voice review before any CHANGELOG / README mention.

## Pre-registered cost and wall-time estimate

- Tarball download: 1.25 GiB over the Qdrant GCS mirror (one-time; estimated <2 min on this sandbox). Tarball MD5 is verified against the GCS `x-goog-hash` header before extraction; on mismatch, the partial file is deleted and the download retries up to 3× with 4-second backoff before failing Gate-A.
- Re-embed wall time: 940 sessions × ~150 tokens median × 1024-dim FP32 mean-pool on CPU via `@xenova/transformers` onnxruntime-web → estimated 15-30 minutes (e5-large is ~3× slower than BGE-base for the same batch size).
- Retrieval wall time: 500 queries × top-100 hybrid (vector + BM25 + RRF) → estimated 3-8 minutes.
- F9 rerank: existing pattern, sub-agent dispatch, estimated 10-20 minutes for 500 queries.
- Total cost: $0 in API spend (local embeddings, sub-agent rerank via the same controller dispatch as F9 v2). One sub-agent run is bounded to the same token budget as F9 v2.

## Provenance (to be completed during execution)

- Dataset: `data/longmemeval_oracle.json`, SHA-256 `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c` (verified before run; matches F8 / F11 anchor).
- Store: `hippo_store2/` (940 sessions, ingested in F6).
- Embedding model: `intfloat/multilingual-e5-large` (alias `Xenova/multilingual-e5-large`).
- Embedding-model source: `https://storage.googleapis.com/qdrant-fastembed/fast-multilingual-e5-large.tar.gz`.
- Tarball MD5 (base64, from GCS `x-goog-hash` header): `qfG9AF6uyVOG9RgHd1XpLA==`.
- Tarball MD5 (hex, ETag): `a9f1bd005eaec95386f518077755e92c`.
- Tarball stored size: 1,311,120,679 bytes.
- Tarball internal layout: filled in during Task 1 after extraction.
- Smoke-load (filled in during Task 1): `<load time ms> / <first 5 normalized values of a "query: hello" embedding>`.
- Re-embed wall time (filled in during Task 3): `<seconds>` / final `embeddings.e5large.json` size: `<MB>`.

## Embedding-model compatibility note

The hippo store carries `meta.embedding_model` exactly so that mixed-model embeddings are detected. F12's re-embed REPLACES `embeddings.json` for all 940 sessions in a single pass — no mixed state. The BGE-base `embeddings.json` is preserved as `embeddings.bge-base.json.bak` (mirroring the existing `embeddings.minilm.json.bak`) so reverting on Gate-B FAIL is a single `mv`.

## Outside-voice review trail

### Review (2026-05-11, isolated-context general-purpose subagent, Sonnet)

**Verdict:** PASS_WITH_NOTES (15/15 checks PASS or PASS_WITH_NOTE).

Summary of per-check results:

1. Verbatim retraction sentence — PASS.
2. Strict magnitude grep declared — PASS.
3. Gate-A operational (count == 940, dim == 1024, L2-norm, meta row, prefix smoke) — PASS.
4. Gate-B arithmetic 78.2 + 5.0 = 83.2 — PASS (cross-checked against F11 result doc's F11+F9 stack appendix).
5. HARD RETRACTION concrete, matches F10 pattern — PASS.
6. Stretch NON-binding — PASS.
7. Split-mismatch disclosure binding — PASS (note: per-embedder mismatch also worth surfacing — addressed in revision).
8. Cumulative-null cite `docs/RETRACTION.md:94-113` — PASS.
9. Outside-voice clauses present — PASS.
10. Provenance complete (SHA-256 anchor matches F8/F11) — PASS.
11. Mixed-store risk addressed (single-pass REPLACE) — PASS.
12. No conflicts with parent plan / prior tracks — PASS.
13. e5 prefix convention correctly characterized — PASS.
14. Cost/wall-time plausible — PASS (note: e5-large speed estimate unverified, addressed by retry/abort logic for download).
15. Free-form: three minor gaps flagged (— addressed in revision).

**Required fixes:** none.

**Optional improvements applied (this revision):**

1. Added per-embedder mismatch note to the split-mismatch disclosure section.
2. Added tiebreak rule for Gate-B (higher R@5; then R@1; then R@3).
3. Clarified `--min-results` revert scope: README's recommended invocation reverts, the CLI flag stays as a flag.
4. Added MD5-verify-and-retry logic to the tarball download cost section.

Controller authorised to proceed with Task 1 (model fetch).
