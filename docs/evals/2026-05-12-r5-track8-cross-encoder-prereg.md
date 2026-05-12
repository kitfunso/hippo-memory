# LongMemEval R@5 target — Track 8 (F15) cross-encoder rerank on F14 top-100 — pre-registration

**Date:** 2026-05-12
**Predecessors:** F14 FAIL by 46.9pp (Gate-B R@5 = 50.8 vs threshold 97.7); F13 deployable at oracle R@5 = 86.8.

**Motivation:** F14 established that BGE-base chunked turn-level retrieval places the answer-bearing session inside the top-100 candidate pool 86.2 % of the time on the `_s` split (F14 R@100 = 86.2), but ranks it inside the top-5 only 42.0 % of the time at the F14 baseline (58.0 % top-5 miss rate) and only 50.8 % even with F9 sub-agent rerank stacked on top (49.2 % top-5 miss rate). The answer is in F14's pool for ~86 % of queries; the bi-encoder cosine + sub-agent rerank just doesn't rank it high enough in roughly half of those. Cross-encoders score (query, candidate) jointly via cross-attention and are qualitatively stronger than bi-encoders at fine-grained relevance discrimination. F15 applies a cross-encoder reranker over F14's pre-computed top-100 candidate pool to measure how much of the within-pool ranking gap can be closed by a locally-runnable cross-encoder, without touching the embedder.

This release does not re-assert the retracted −10pp magnitude.

---

## Provenance disclosure (binding)

F15 inherits the same data source as F14. The `_s` data used in this track is sourced from `https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz` (decompressed SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`). The mirror's `README.md` states it is the English source for a Chinese-translation pipeline; the file matches the canonical schema described in the official LongMemEval README (`question_id`, `answer_session_ids`, `haystack_session_ids`, `haystack_sessions`, etc.) and shares all 500 question_ids with our verified `data/longmemeval_oracle.json` (SHA-256 `821a2034a...`).

**The Sanderhoff-alt repo is an unaffiliated third-party personal GitHub account with no documented institutional or provenance link to the LongMemEval authors (xiaowu0162) or to the canonical HF release at `huggingface.co/datasets/xiaowu0162/longmemeval-cleaned`. There is no signed chain-of-custody from HF to this mirror.** The only integrity signal available is the 500/500 question_id match with our independently verified oracle file plus the canonical-schema match. This is NOT a verified-against-HF copy (HF Hub is host-blocked); the F15 result doc must label all numbers as "measured against the Sanderhoff-alt mirror" with the same tamper caveat carried from F14. F15 introduces no new data source; all candidate pairs scored by the cross-encoder are drawn from F14's pre-computed `results/f14_baseline/turn_bge_s_top100.jsonl`.

## Embedder mismatch with gbrain (binding)

gbrain v0.28.8 uses OpenAI `text-embedding-3-large@1536` (`api.openai.com` host-blocked from this sandbox, confirmed 2026-05-11 + 2026-05-12 egress audits). F14/F15 use `Xenova/bge-base-en-v1.5` as the bi-encoder (768-dim CLS pooling, vendored locally via the Qdrant fastembed GCS bucket). gbrain's published gbrain-vector adapter (pure-embedding ablation) scored 97.40 % R@5 on `_s`; the embedder is the dominant factor in gbrain's headline. **F15 measures BGE-base bi-encoder (candidate pool) + cross-encoder rerank on `_s`; gbrain measures text-embedding-3-large + sessions-as-chunks + RRF on `_s`. The split is matched; the embedder is not.** The cross-encoder is a NEW component beyond what F14 measured — F14 measured BGE-base cosine ranking and F9 sub-agent rerank; F15 replaces the rerank stage with a locally-running neural cross-encoder.

## Cross-encoder model selection rationale (binding)

Two cross-encoder variants are pre-registered and both will run end-to-end regardless of Gate-B outcome:

- **Feasibility tier:** `Xenova/ms-marco-MiniLM-L-6-v2` (22M parameters; ~30 (query, candidate) pair/s on CPU; MS MARCO fine-tuned; fast enough to process 500 × 100 = 50,000 pairs in ~28 min on the 4-core CPU).
- **Quality tier:** `Xenova/bge-reranker-base` (278M parameters; ~3–5 pair/s on CPU; BGE reranker fine-tune; expected 2.8–4.6 h wall time for 50,000 pairs on the 4-core CPU).

Both models are loaded via the Qdrant fastembed GCS bucket (HuggingFace Hub is host-blocked from this sandbox, verified 2026-05-11 + 2026-05-12 egress audits). Both variants run end-to-end; both are individually tabled in the F15 result doc regardless of Gate-B outcome. The best variant is selected post-hoc for the Gate-B verdict. Model weights are cached under `benchmarks/longmemeval/data/model-cache/` during execution; the before/after `find` manifests captured during Task 4 and Task 6 of the implementation plan precisely identify which weights are newly downloaded (and therefore subject to deletion under the HARD RETRACTION arm).

## Goal

Apply cross-encoder reranking over F14's pre-computed candidate pool. Concretely:

1. Load F14's top-100 retrieval output (`results/f14_baseline/turn_bge_s_top100.jsonl`, 500 queries × 100 candidates each) — no new bi-encoder index needed.
2. For each query, score all 100 (query, candidate text) pairs with the cross-encoder model; retain the full candidate set (permutation only, no additions or deletions).
3. Sort the 100 candidates descending by cross-encoder score.
4. Evaluate the reranked output with `benchmarks/longmemeval/evaluate_retrieval.py` (the canonical scorer; same invocation used in F14).

Both cross-encoder variants (feasibility tier and quality tier) are run end-to-end and individually tabled in the result doc. Gate-B verdict uses the best of the two.

## Magnitude-smuggling guard

Per `docs/RETRACTION.md`. Strict grep before commit:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' <file>
```

The verbatim retraction sentence — `This release does not re-assert the retracted −10pp magnitude.` — must appear on its own line in the F15 result doc and in every commit body that touches result artefacts.

## Workload-validity gates (binding)

### Gate-A — workload validity

After running the cross-encoder rerank:

- Cross-encoder model loads successfully from the Qdrant fastembed GCS bucket (vendored from GCS, not HF Hub). Rejects silent HF-fallback that would fail mid-run.
- For each query, the reranked candidate set is a permutation of F14's top-100: same 100 session_ids, no candidate dropped or invented. Rejects accidental deduplication, truncation, or candidate injection bugs.
- Score distribution non-degenerate: stddev of cross-encoder scores across the 100 candidates per query > 0.01 for ≥ 90 % of queries. Rejects all-zeros or constant-score bugs where the model silently returns uniform scores.
- At least 50 % of queries have a different top-1 session_id from F14 baseline (BGE-base cosine, no rerank). Rejects a no-op rerank where the cross-encoder merely preserves the bi-encoder's ordering.
- Wall-time per query is logged; aggregate throughput within 2× of the feasibility-spike estimate (≥ 15 pair/s for feasibility tier; ≥ 1.5 pair/s for quality tier). Rejects silent OOM-thrash that would inflate wall time without raising an error.
- Tags-passthrough check: every output candidate's `tags` field is non-empty and exactly matches the input candidate's `tags` from `turn_bge_s_top100.jsonl`. Without this, a tags-stripping bug would silently zero out Gate-B hits: the canonical scorer `evaluate_retrieval.py`'s `check_session_hit` matches via three paths (`sid in tags` exact, `[Session: sid]` content marker, `any(sid in t for t in tags)` partial), and two of those three paths require the `tags` field to be populated.

PASS = all six conditions. FAIL = fix and re-run; not a retraction trigger.

### Gate-B — proven value at R@5 (binding, HARD RETRACTION on FAIL)

The F15 best variant — defined as max(R@5) across (a) feasibility-tier cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`) and (b) quality-tier cross-encoder (`Xenova/bge-reranker-base`) — measured by `evaluate_retrieval.py` against the Sanderhoff-alt mirror of `longmemeval_s_cleaned.json`, must satisfy:

**R@5 ≥ 97.7 %** on `_s`.

The 97.7 threshold is gbrain v0.28.8's published 97.60 % R@5 on `_s` plus a 0.1 % margin. The Gate-B verdict binds on the canonical scorer `benchmarks/longmemeval/evaluate_retrieval.py` (which matches via three paths: `sid in tags` exact, `[Session: sid]` content marker, `any(sid in t for t in tags)` partial). Any inline scorer is a comparison helper only; if it diverges from `evaluate_retrieval.py`, the canonical number binds.

PASS = best F15 variant `recall@5 ≥ 0.977` → conventional release update (CHANGELOG / README / ROADMAP / RETRACTION canonical docs updated to cite F15 numbers).
**FAIL** = best F15 variant `recall@5 < 0.977` → **HARD RETRACTION** (see below).

#### Structural ceiling (required)

F14's R@100 on `_s` = 86.2 % is the absolute upper bound on F15's achievable R@5. A rerank can only reorder within the candidate pool; it cannot promote a session that does not appear in F14's top-100 into any top-K position. Since 13.8 % of answer-bearing sessions are absent from F14's top-100, the best reranker conceivable — one that perfectly orders the candidates — can achieve at most R@5 = 86.2 % on this pool.

86.2 < 97.7, therefore F15 cannot mathematically clear Gate-B from the F14 candidate pool alone.

The Gate-B threshold remains 97.7 because the project's discipline forbids retargeting gates to what an experiment can achieve. Lowering the threshold to fit within the structural ceiling is exactly the magnitude-smuggling pattern that `docs/RETRACTION.md` disciplines against. **F15's HARD RETRACTION is the expected outcome per this prereg.** The legitimate value F15 delivers is mechanism characterisation: measuring how much of the within-pool ranking gap (the 86.2 % R@100 − 42.0 % R@5 = 44.2-point within-pool gap) a locally-runnable cross-encoder closes, and which cross-encoder architecture closes more of it.

The path to actually clearing Gate-B is F15 + F16 combined: apply a cross-encoder on top of a stronger bi-encoder that lifts R@100 closer to 100 % (closing the 13.8-point out-of-pool gap). F16 is queued in `ROADMAP-RESEARCH.md`.

## HARD RETRACTION arm (binding)

On Gate-B FAIL, the following four actions are executed in full:

1. `data/lme_s/` deleted from disk (entire directory; gitignored data artefact).
2. `results/f15_cross_encoder/` deleted from disk (all F15 output files).
3. Cross-encoder model weights under `benchmarks/longmemeval/data/model-cache/` deleted ONLY for newly-downloaded models. Precision comes from before/after `find` manifests captured during Task 4 (pre-run manifest) and Task 6 (post-run manifest) of the implementation plan; the diff between those two manifests is the exact `rm -rf` list. Existing F11/F13/F14 model weights under `model-cache/` are retained.
4. CHANGELOG / README / ROADMAP / RETRACTION canonical docs are NOT updated to cite F15 numbers.

The F15 result doc is retained as a negative-result audit trail regardless of Gate-B outcome.

## Cumulative-null acknowledgement

Per `docs/RETRACTION.md:94-113`. F15 continues the cumulative null trajectory established through v1.7.5/6/7/8 + v1.8.1 across the dlPFC goal-stack mechanism evaluations. F15 introduces (i) a staged `results/f15_cross_encoder/` directory (gitignored), (ii) cross-encoder model weights under `benchmarks/longmemeval/data/model-cache/` (gitignored, size TBD by run), (iii) F15 prereg + result docs. F15 reuses F14's `results/f14_baseline/turn_bge_s_top100.jsonl` as its candidate input; no new bi-encoder index is built. F15 adds a new rerank driver script (`benchmarks/longmemeval/cross_encoder_rerank.py` or equivalent); this is a `benchmarks/` change, not a `src/` change; the mechanism-null framing is unaffected.
