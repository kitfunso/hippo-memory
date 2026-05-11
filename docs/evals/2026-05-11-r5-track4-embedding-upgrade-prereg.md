# LongMemEval R@5 target — Track 4 (F11) embedding-upgrade — pre-registration

**Date:** 2026-05-11
**Plan:** `docs/plans/2026-05-11-r5-track4-embedding-upgrade.md`
**Predecessors:** F8 (hybrid tuning, R@5 = 76.8%), F9 v2 (sub-agent LLM rerank on F8 best config, R@5 = 78.0%, R@1 = 59.4%).
**Successor (sequencing):** F10 (richer ingest) runs against whichever store F11 leaves behind.

This release does not re-assert the retracted −10pp magnitude.

---

## Goal

Swap `Xenova/all-MiniLM-L6-v2` (384-dim, mean pooling) for `BAAI/bge-base-en-v1.5` (768-dim, CLS pooling) as the embedding model used to populate `hippo_store2/.hippo/embeddings.json`, then re-baseline retrieval. Test the hypothesis that a stronger embedding model lifts R@5 closer to the roadmap target of 85%.

## Magnitude-smuggling guard

Per `docs/RETRACTION.md`. The strict grep below must return zero matches against the F11 result doc and any CHANGELOG / README mention before commit:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' <file>
```

The verbatim retraction sentence — `This release does not re-assert the retracted −10pp magnitude.` — must appear on its own line in the F11 result doc and in every commit body that touches result artefacts.

## Workload-validity gates (binding)

### Gate-A — workload validity

After running `hippo embed` against `hippo_store2/` with `embeddings.model = "Xenova/bge-base-en-v1.5"` (or alias) configured, all 940 memories must have a populated embedding vector in `hippo_store2/.hippo/embeddings.json`:

- `Object.keys(idx).length === 940`
- For every key, `idx[key].length === 768` (BGE-base hidden size)
- For at least the first 50 keys (spot-check), `L2-norm(idx[key]) ∈ [0.999, 1.001]` (normalised output)
- `meta.embedding_model` row in `hippo_store2/.hippo/hippo.db` reads `Xenova/bge-base-en-v1.5` (or the `BAAI/bge-base-en-v1.5` canonical id; both refer to the same weights)

PASS = all four conditions met. FAIL = any condition unmet → fix and re-run; not a retraction trigger.

### Gate-B — proven value at R@5

With the F8 winning hybrid hyperparameters (`embeddingWeight=0.5, mmrLambda=0.7, budget=50, minResults=5`), R@5 on the BGE-base store, as measured by `benchmarks/longmemeval/retrieve_inprocess.mjs` against `data/longmemeval_oracle.json` and scored by `benchmarks/longmemeval/evaluate_retrieval.py`, must be ≥ 81.8% (= F8 best 76.8% + 5pp).

PASS = `recall@5 ≥ 0.818`. FAIL = `recall@5 < 0.818` → descriptive only, no retraction (F11 is a config-level change, not a `src/` mechanism). MiniLM stays the project default; the `poolingFor` dispatch in `src/embeddings.ts` is retained regardless of outcome.

### Stretch target (NON-binding)

R@5 ≥ 85% (roadmap F6 target per `ROADMAP-RESEARCH.md`). NON-binding per this prereg; Gate-B remains the single binding R@5 number.

## Failure handling

- **Gate-A FAIL:** model loading or embedding population is broken; fix and re-run. Not a retraction trigger.
- **Gate-B FAIL:** **descriptive only**, no retraction. The F11 result doc records the FAIL verdict and per-K / per-type numbers. F10 still proceeds (against the BGE store if Gate-A PASS, against MiniLM otherwise).

## Cumulative-null acknowledgement

The F11 result doc must cite `docs/RETRACTION.md:94-113` and confirm the dlPFC goal-stack cumulative-null status is unaffected by F11. F11 introduces a small per-model `poolingFor` dispatch helper in `src/embeddings.ts` (BGE → CLS, default → mean) but otherwise touches no mechanism in `src/`. The retraction inventory and cumulative-null escalation status documented in RETRACTION.md are independent of this evaluation.

## Outside-voice review

The plan that embeds this prereg verbatim was reviewed (verdict: PASS_WITH_NOTES, four optional improvements applied at commit `01a3975`). This prereg document itself is dispatched for a fresh isolated-context review (per F8 / F9 convention) before Task 4 (model fetch) begins. The result doc will undergo a separate outside-voice review before any CHANGELOG / README mention.

## Provenance (to be completed during execution)

- Dataset: `data/longmemeval_oracle.json`, SHA-256 `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c` (anchored from F8 result doc).
- Store: `hippo_store2/` (940 sessions, ingested in F6).
- Embedding model: `BAAI/bge-base-en-v1.5` (alias `Xenova/bge-base-en-v1.5`).
- Embedding-model source: `https://storage.googleapis.com/qdrant-fastembed/fast-bge-base-en-v1.5.tar.gz` (Qdrant fastembed GCS, allowlisted in this sandbox).
- Tarball MD5 (base64, from GCS `x-goog-hash` header): `zD+/65myZ/5XsJN3BDO92w==`.
- Tarball internal layout: `fast-bge-base-en-v1.5/{config.json, tokenizer.json, tokenizer_config.json, special_tokens_map.json, vocab.txt, model_optimized.onnx, ort_config.json}`. `ort_config.json` declares `fp16: true, optimize_for_gpu: true`. The FP16 weights run on CPU via onnxruntime-web (slower per inference but functionally correct).
- Smoke-load (filled in during Task 4): `<load time ms> / <first 5 normalized values of a sample vector>`.
- Re-embed wall time (filled in during Task 5): `<seconds>` / final `embeddings.json` size: `<MB>`.

## Outside-voice review trail (filled in after Task 1 step 3)

`<reviewer verdict + per-check results + required fixes>`
