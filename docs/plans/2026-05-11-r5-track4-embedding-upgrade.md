# LongMemEval R@5 target — Track 4: stronger embedding model (bge-base-en-v1.5)

> **For agentic workers:** execute task-by-task; each task ends in a commit. Stay on the assigned branch; controller pushes.

**Goal:** swap `Xenova/all-MiniLM-L6-v2` (384-dim) for `BAAI/bge-base-en-v1.5` (768-dim) in `hippo_store2/`, re-baseline retrieval, and measure whether the stronger embedding model lifts R@5 closer to the roadmap target of 85%.

**Architecture:** the F8 hybrid-tuning sweep maxed R@5 at 76.8% with MiniLM. The F9 v2 sub-agent LLM rerank lifted R@5 to 78.0% on top of that. The R@10 ceiling of the MiniLM candidate pool was 82.4%, so any reranker working on top-20 candidates is capped near 87.6% even with perfect ranking. A stronger embedding model raises that ceiling. BGE-base is the strongest model accessible from this sandbox: it lives in the Qdrant fastembed Google Cloud Storage bucket (already proven reachable for F8/F9), ships as a 195 MB tarball, and uses CLS pooling (not MiniLM's mean pooling — `src/embeddings.ts` needs a per-model dispatch).

**Tech stack:** TypeScript (`src/embeddings.ts` patch), Node 22 (existing harness), `@xenova/transformers` (already a dep, loads BertModel from local ONNX), Vitest.

**Predecessor:** Plans F8 (`docs/plans/2026-05-11-r5-track1-hybrid-tuning.md`), F9 (`docs/plans/2026-05-11-r5-track2-cross-encoder-real.md`). The F9 v2 result doc records the best MiniLM-era number as R@5 = 78.0% with sub-agent LLM rerank.

**Sequencing:** F11 runs after F8/F9 and before F10. F10 (richer ingest) layers signals on top of whatever embedding model is active; F11 finishes first so F10's measurements are taken against a single, current candidate-pool quality.

---

## Pre-registration

This release does not re-assert the retracted −10pp magnitude.

**Magnitude-smuggling guard.** Per `docs/RETRACTION.md`. Same strict-grep clause as Plans F8 / F9:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' <result-doc>
```

Must return zero matches in the result doc and CHANGELOG entry.

**Workload-validity gates (binding):**

- **Gate-A (workload validity):** after running `hippo embed` against `hippo_store2/`, all 940 memories must have a populated embedding vector in `hippo_store2/.hippo/embeddings.json` (≥ 940 keys), each of length 768 (BGE-base hidden size), each L2-normalized (norm in `[0.999, 1.001]`). The `meta.embedding_model` row in `hippo_store2/.hippo/hippo.db` must read `BAAI/bge-base-en-v1.5` or the cache-aliased equivalent (`Xenova/bge-base-en-v1.5`).
- **Gate-B (proven value):** with the F8 winning hybrid hyperparameters (`embeddingWeight=0.5, mmrLambda=0.7, budget=50, minResults=5`), R@5 on the BGE-base store must be ≥ 81.8% (F8 best on MiniLM = 76.8% + 5pp). Measured by `benchmarks/longmemeval/retrieve_inprocess.mjs` against `data/longmemeval_oracle.json` and `benchmarks/longmemeval/evaluate_retrieval.py`.

**Stretch target (NON-binding):** R@5 ≥ 85% (roadmap F6 target). NON-binding per `ROADMAP-RESEARCH.md` and this prereg.

**Failure handling:**

- **Gate-A FAIL:** model loading or embedding population is broken; fix and re-run. Not a retraction trigger.
- **Gate-B FAIL:** **descriptive only**, no retraction. F11 changes a config-level value (which embedding model is configured), not a `src/` mechanism. The original MiniLM model stays the project default. The result doc records the FAIL verdict and per-K / per-type numbers. F10 still proceeds, defaulting back to MiniLM unless F11 partially succeeds (Gate-A PASS but Gate-B FAIL → F10 runs on the new BGE store anyway and reports its own per-mechanism delta).

**Outside-voice review:** the prereg (this section embedded in the plan) must pass outside-voice review before Task 3 (model fetch) starts. The result doc must pass outside-voice review before any CHANGELOG / README mention.

**Cumulative-null acknowledgement:** the result doc must cite `docs/RETRACTION.md:94-113` and confirm the dlPFC goal-stack cumulative-null status is unaffected. F11 changes no mechanism in `src/` beyond a per-model pooling dispatch.

---

## File structure

| File | Responsibility | Status |
|---|---|---|
| `docs/evals/2026-05-11-r5-track4-embedding-upgrade-prereg.md` | Pre-registration | CREATE |
| `docs/evals/2026-05-11-r5-track4-embedding-upgrade-result.md` | Result doc | CREATE (Task 7) |
| `scripts/fetch_embedding_model.mjs` | Generalise to take `--model` flag and look up Qdrant URL | MODIFY |
| `src/embeddings.ts` | Add `poolingFor(model)` so BGE uses CLS, MiniLM keeps mean | MODIFY |
| `tests/embeddings/pooling.test.ts` | TDD: poolingFor returns `'cls'` for bge, `'mean'` for MiniLM | CREATE |
| `hippo_store2/.hippo/config.json` | Set `embeddings.model = "Xenova/bge-base-en-v1.5"` | MODIFY (local-only, gitignored) |
| `results/f11_baseline/bge-base.jsonl` | Per-query retrieval output (top-20) | CREATE (gitignored) |
| `results/f11_baseline/bge-base.eval.json` | R@K eval | CREATE (gitignored) |

---

## Tasks

### Task 1: Pre-registration document + outside-voice review

**Files:**
- Create: `docs/evals/2026-05-11-r5-track4-embedding-upgrade-prereg.md` (copy the Pre-registration section above verbatim, plus a "Provenance" stub).

**Steps:**
1. Write the prereg file. Verbatim retraction sentence + strict grep + gates + failure handling + outside-voice clause.
2. Run the magnitude-smuggling grep on the prereg itself; assert 0 matches.
3. Dispatch an outside-voice subagent reviewer (general-purpose, sonnet, isolated context). Prompt mirrors the F8/F9 prereg review structure.
4. Append the reviewer's verdict + per-check results to the bottom of the prereg.
5. Gate: if reviewer verdict is FAIL, apply required fixes and re-dispatch. If PASS or PASS_WITH_NOTES, proceed.

**Commit:** `docs(evals): F11 prereg — embedding-upgrade (bge-base-en-v1.5)`.

### Task 2: Generalise `scripts/fetch_embedding_model.mjs`

**Files:** `scripts/fetch_embedding_model.mjs`.

**Steps:**
1. Add a `--model` CLI flag with two supported values:
   - `Xenova/all-MiniLM-L6-v2` (current default; preserves backwards compat with F8/F9)
   - `Xenova/bge-base-en-v1.5` (alias for `BAAI/bge-base-en-v1.5`)
2. Internal table maps model id → tarball URL + expected base64 MD5 + tar-internal prefix:
   - MiniLM: `sentence-transformers-all-MiniLM-L6-v2.tar.gz`, MD5 `ES1rh090kuh/nhAyKdCO0A==`, prefix `fast-all-MiniLM-L6-v2`, ONNX file `model.onnx`.
   - BGE-base: `fast-bge-base-en-v1.5.tar.gz`, MD5 `zD+/65myZ/5XsJN3BDO92w==`, prefix `fast-bge-base-en-v1.5`, ONNX file `model_optimized.onnx` (renamed to `onnx/model.onnx` in the destination layout).
3. Idempotent (skip if destination ONNX file already present). `--force` re-fetches.
4. TDD via a smoke command in `package.json` is out of scope; manual smoke is fine.

**Commit:** `feat(scripts): fetch_embedding_model.mjs supports bge-base-en-v1.5 from Qdrant GCS`.

### Task 3: Per-model pooling dispatch in `src/embeddings.ts`

**Files:** `src/embeddings.ts`, new `tests/embeddings/pooling.test.ts`.

**Steps:**
1. Add `function poolingFor(model: string): 'cls' | 'mean'` near the top of the file. Implementation: `/\bbge\b/i.test(model) ? 'cls' : 'mean'`. Add a code comment explaining: BGE was trained with CLS pooling per BAAI's official inference code; MiniLM uses mean pooling per sentence-transformers.
2. Pass `pooling: poolingFor(model)` (replace the hardcoded `'mean'`) in the single `pipe(text, { ... })` call in `getEmbedding`.
3. TDD test asserts `poolingFor('Xenova/bge-base-en-v1.5') === 'cls'`, `poolingFor('Xenova/all-MiniLM-L6-v2') === 'mean'`, and that unknown model ids default to `'mean'` (the model-agnostic safe choice). Test file uses vitest, no network or model load.
4. Rebuild dist (`npx tsc`).
5. Existing `tests/embeddings/local-cache.test.ts` still passes (it embeds with MiniLM; pooling is still `'mean'`).

**Commit:** `feat(embeddings): per-model pooling dispatch (bge=cls, default=mean)`.

### Task 4: Fetch the bge-base model + smoke-load it

**Steps:**
1. Run `node scripts/fetch_embedding_model.mjs --model Xenova/bge-base-en-v1.5`. Asserts MD5; lays out the cache.
2. Run a small smoke script (10-line `.mjs` in `/tmp/`, deleted after): load the pipeline via `@xenova/transformers` with `HIPPO_MODEL_CACHE` pointing at the local cache, embed a sample sentence, assert vector length 768.
3. Record load time + first-vector first-5-values in the prereg's Provenance section (for reproducibility).

**Commit:** none for this task (no source changes).

### Task 5: Re-embed `hippo_store2/` with bge-base

**Steps:**
1. Snapshot the existing MiniLM embeddings: `cp hippo_store2/.hippo/embeddings.json hippo_store2/.hippo/embeddings.minilm.json.bak`. (Gitignored; lives in store dir.)
2. Configure: edit `hippo_store2/.hippo/config.json` so `embeddings.model = "Xenova/bge-base-en-v1.5"`. (If the file doesn't exist, create with that single field + sensible defaults for any required keys.)
3. Run: `HIPPO_MODEL_CACHE=$(pwd)/benchmarks/longmemeval/data/model-cache (cd hippo_store2 && node ../bin/hippo.js embed)`. The reindex path in `src/embeddings.ts` detects the model change and rebuilds embeddings.json from scratch.
4. Verify: 940 vectors, each length 768, all L2-normalized (Gate-A check).
5. Record wall time + final embeddings.json file size in the result doc.

**Commit:** none.

### Task 6: Re-baseline retrieval with bge-base

**Steps:**
1. Run the F8 best-config harness against the bge-base store: `node benchmarks/longmemeval/retrieve_inprocess.mjs --data data/longmemeval_oracle.json --store-dir hippo_store2 --output results/f11_baseline/bge-base.jsonl --embedding-weight 0.5 --mmr-lambda 0.7 --budget 50 --min-results 5`. (Same hyperparameters as the F8 best-config confirmation run.)
2. Score: `python3 benchmarks/longmemeval/evaluate_retrieval.py --retrieval results/f11_baseline/bge-base.jsonl --data data/longmemeval_oracle.json --output results/f11_baseline/bge-base.eval.json`.
3. Also run a deeper-pool variant for downstream rerank: same flags but `--min-results 20 --budget 100` → `results/f11_baseline/bge-base_top20.jsonl`. Score: produces R@20 ceiling for F11 + F9 stacking.

**Commit:** `feat(benchmarks): F11 bge-base baseline retrievals (gitignored)`.

### Task 7: Result doc + Gate verdicts + outside-voice review

**Files:** `docs/evals/2026-05-11-r5-track4-embedding-upgrade-result.md`.

**Required sections:**
1. Title / Author / Date / Plan / Prereg / verbatim retraction sentence.
2. TL;DR (Gate-A and Gate-B verdicts; one-line headline R@5 and R@1; explicit "Roadmap target R@5 ≥ 85% NON-binding per prereg" framing).
3. Provenance: dataset SHA-256, store dir, embedding model id + tarball URL + MD5, fetch script invocation, harness command, evaluator command.
4. Results table: baseline (MiniLM, from F8 result doc) vs F11 (bge-base) R@1 / R@3 / R@5 / R@10 / R@20 / answer_in_content@5. Both columns show raw values, no Δ-pp prose.
5. Per-type breakdown for the same K values.
6. Gate-A verdict (PASS/FAIL with measurable evidence — 940 vectors × 768 dim × normalized).
7. Gate-B verdict (PASS/FAIL with R@5 vs threshold 81.8).
8. Roadmap-target framing (R@5 vs 85, NON-binding).
9. Cumulative-null acknowledgement: `docs/RETRACTION.md:94-113` cite, mechanism independence.
10. Outside-voice review trail (appended after the controller dispatches an isolated-context reviewer).

**Discipline:** run the strict magnitude-smuggling grep on the result doc before committing. Assert 0 matches.

**Commit:** `docs(evals): F11 result — embedding upgrade to bge-base-en-v1.5`.

### Task 8: Hand-off to F10

**Steps:**
1. If Gate-A PASS: F10 will run against the bge-base store. Update F10's plan with a one-line note: "Predecessor: Plan F11 (bge-base embedding). The features reranker is evaluated against the BGE candidate pool."
2. If Gate-A FAIL: revert `hippo_store2/.hippo/config.json` to MiniLM and restore the snapshot (`mv embeddings.minilm.json.bak embeddings.json`). F10 runs on the original MiniLM store.

**Commit:** `docs(plans): F10 hand-off note from F11 result`.

---

## Risk register

- **Risk: BGE-base's ONNX is FP16 (per `ort_config.json`)**, optimized for GPU. CPU inference may be slower than MiniLM's quantized INT8. Mitigation: F11's measurement budget is one-shot (~10 min wall to re-embed 940 sessions); slower per-inference is acceptable.
- **Risk: Pooling-dispatch bug.** If `poolingFor` returns the wrong value, embeddings will be silently bad and R@5 will collapse. Mitigation: Gate-A's L2-norm check catches gross malformation; TDD test in Task 3 catches the dispatch logic. Manual sanity: a sample query's top-1 retrieval should still be the expected answer-bearing memory on at least one or two known-good queries.
- **Risk: Qdrant tarball moves / hash changes.** GCS hashes are stable per object generation; we record the exact MD5 in the fetch script + prereg. If GCS revs the object, MD5 mismatch will halt the script.
- **Risk: Gate-B FAILs and we have nothing to retract.** Acceptable per the prereg's failure-handling clause.

---

## Out of scope

- Adding additional embedding models beyond bge-base. (bge-large is not on the Qdrant bucket; bge-small is smaller than bge-base and would not be a value-add over MiniLM.)
- Quantizing the bge-base ONNX. (Would require onnxruntime tooling; not necessary at 940-memory scale.)
- Changes to `src/rerankers/*`. F11 is embedding-only.
- LLM rerank stacking. That is a separate measurement reported in the F11 + F9 hand-off note (Task 7 section 4 R@20 column) and re-executed only if Gate-B FAILs the standalone F11 R@5 and we want to know whether the LLM rerank closes the gap.
