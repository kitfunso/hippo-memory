# LongMemEval R@5 target — Track 8 (F15) sub-agent rerank on F14 top-100 — pre-registration (revised)

**Date:** 2026-05-12
**Predecessors:** F14 FAIL by 46.9pp (Gate-B R@5 = 50.8 vs threshold 97.7); F13 deployable at oracle R@5 = 86.8.

**Motivation:** F14 established that BGE-base chunked turn-level retrieval places the answer-bearing session inside the top-100 candidate pool 86.2 % of the time on the `_s` split (F14 R@100 = 86.2), but ranks it inside the top-5 only 42.0 % of the time at the F14 baseline (58.0 % top-5 miss rate) and only 50.8 % even with F9 sub-agent rerank stacked on top (49.2 % top-5 miss rate). The answer is in F14's pool for ~86 % of queries; the bi-encoder cosine + F9 sub-agent rerank just doesn't rank it high enough in roughly half of those. **F15 turns up every parameter of the sub-agent rerank** — more capable LLM (Opus 4.7 vs F9's Sonnet/Haiku), deeper pool (top-100 vs F9's top-20), richer per-candidate context (1000 chars vs F9's 600), and a structured-rubric prompt (vs F9's "rank these") — to measure how much of the within-pool ranking gap a maximally-equipped LLM-as-reranker can close, holding the embedder constant.

This release does not re-assert the retracted −10pp magnitude.

---

## Pivot history

The original F15 prereg (commits `e4525b6` and `8a88880`) registered a **neural cross-encoder rerank** mechanism using `Xenova/ms-marco-MiniLM-L-6-v2` and `Xenova/bge-reranker-base` vendored from the Qdrant fastembed GCS bucket. Task 4 of the implementation plan attempted the model vendoring and discovered a hard structural block: the sandbox's network egress allowlist denies HuggingFace Hub and all known HF mirrors (`hf-mirror.com`, `modelscope.cn`, `aliendao.cn`, `cdn-uploads.huggingface.co`, etc.), AND the Qdrant fastembed GCS bucket mirrors **embedding models only** — every cross-encoder in fastembed's catalog has `sources={'hf': '...', 'url': None}` (verified by reading `/usr/local/lib/python3.11/dist-packages/fastembed/rerank/cross_encoder/`). PyPI alternatives (`flashrank`, `rerankers`) all wrap HuggingFace as their first-line model source. No in-sandbox-reachable mirror carries cross-encoder ONNX weights.

The plan author missed this when writing the prereg ("via Qdrant fastembed GCS bucket (HF Hub host-blocked)" — both clauses correct individually, but they don't compose into "cross-encoders are reachable"). Both the outside-voice review and the eng-review took the GCS assumption on faith because F11/F13/F14 vendored their embedders that way. The implementer caught the structural failure at the spike.

**F15 is therefore re-registered as a sub-agent rerank track** with the same input, same Gate-B threshold, same HARD RETRACTION arm, and the same structural-ceiling acknowledgement — but the rerank mechanism is a maximally-equipped LLM-as-reranker rather than a neural cross-encoder. The neural cross-encoder mechanism is queued for a future track conditional on either (a) network egress being widened to include HF Hub or one of its mirrors, or (b) the user providing a pre-downloaded model tarball from outside the sandbox. This revised prereg supersedes the original at the level of Sections 4 (mechanism), 7 (Gate-A conditions), 9 (HARD RETRACTION cleanup list), and 10 (no model weights). The retraction line, provenance, embedder-mismatch framing, Gate-B threshold, and structural-ceiling framing carry through unchanged.

## Provenance disclosure (binding)

F15 inherits the same data source as F14. The `_s` data used in this track is sourced from `https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz` (decompressed SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`). The mirror's `README.md` states it is the English source for a Chinese-translation pipeline; the file matches the canonical schema described in the official LongMemEval README (`question_id`, `answer_session_ids`, `haystack_session_ids`, `haystack_sessions`, etc.) and shares all 500 question_ids with our verified `data/longmemeval_oracle.json` (SHA-256 `821a2034a...`).

**The Sanderhoff-alt repo is an unaffiliated third-party personal GitHub account with no documented institutional or provenance link to the LongMemEval authors (xiaowu0162) or to the canonical HF release at `huggingface.co/datasets/xiaowu0162/longmemeval-cleaned`. There is no signed chain-of-custody from HF to this mirror.** The only integrity signal available is the 500/500 question_id match with our independently verified oracle file plus the canonical-schema match. This is NOT a verified-against-HF copy (HF Hub is host-blocked); the F15 result doc must label all numbers as "measured against the Sanderhoff-alt mirror" with the same tamper caveat carried from F14. F15 introduces no new data source; all candidate pairs scored by the sub-agent reranker are drawn from F14's pre-computed `results/f14_baseline/turn_bge_s_top100.jsonl`.

## Embedder mismatch with gbrain (binding)

gbrain v0.28.8 uses OpenAI `text-embedding-3-large@1536` (`api.openai.com` host-blocked from this sandbox, confirmed 2026-05-11 + 2026-05-12 egress audits). F14/F15 use `Xenova/bge-base-en-v1.5` as the bi-encoder (768-dim CLS pooling, vendored locally via the Qdrant fastembed GCS bucket). gbrain's published gbrain-vector adapter (pure-embedding ablation) scored 97.40 % R@5 on `_s`; the embedder is the dominant factor in gbrain's headline. **F15 measures BGE-base bi-encoder (candidate pool) + Claude Opus 4.7 sub-agent rerank on `_s`; gbrain measures text-embedding-3-large + sessions-as-chunks + RRF on `_s`. The split is matched; the embedder is not, and the reranker class is also not directly comparable** (a frontier LLM reranker is qualitatively a different mechanism from gbrain's hybrid+RRF). F15's rerank is a NEW configuration beyond F14: F14's F9 rerank used a less capable model on a shallower pool with simpler prompts; F15 turns each of those levers up.

## Sub-agent rerank parameterisation rationale (binding)

F15 reuses the F9 infrastructure (`benchmarks/longmemeval/rerank_split_v2.py` + `rerank_merge_v2.py`) with three differences from the F9-on-`_s` baseline that F14 produced:

| Parameter | F9 (in F14 stack) | F15 | Lever |
|---|---|---|---|
| Reranker model | Sonnet 4.6 sub-agent | **Opus 4.7 sub-agent** | More capable LLM |
| Candidate pool | top-20 per query | **top-100 per query** | Deeper pool — addresses F9's "only saw the easy 20" limitation |
| Per-candidate context | 600 chars truncation | **1000 chars truncation** | More evidence per candidate for the rubric |
| Batch size | 10 queries per batch | **5 queries per batch** | Smaller batches keep Opus's input under ~50k tokens each |
| Rerank prompt | simple "rank these" | **structured rubric** (topical match, evidence specificity, recency-of-claim) | Better signal extraction |
| Total dispatches | 50 sub-agent calls | **100 sub-agent calls** | (500 / 5) |

The single variant `F15-opus` runs end-to-end and is tabled in the result doc. Gate-B verdict uses F15-opus's R@5; the result doc reports the F14 baseline (42.0), F14+F9-Sonnet stack (50.8), and F15-opus side-by-side so the marginal lift from each rerank lever (model class, pool depth, context width, rubric) can be read off the table.

## Goal

Apply Claude Opus 4.7 sub-agent reranking over F14's pre-computed candidate pool. Concretely:

1. Load F14's top-100 retrieval output (`results/f14_baseline/turn_bge_s_top100.jsonl`, 500 queries × 100 candidates each) — no new bi-encoder index needed.
2. Split into 100 batches of 5 queries each, with up to 100 candidates per query and 1000-char content truncation per candidate, using a slightly extended variant of `rerank_split_v2.py`.
3. Dispatch 100 sub-agent calls (Claude Opus 4.7) with a structured-rubric prompt that scores each candidate on topical match + evidence specificity + recency-of-claim, then emits a ranked id list. Up to 10 dispatches run in parallel via `Agent` tool calls; the rest run sequentially as dispatch slots free.
4. Merge the 100 rerank outputs back into a single JSONL with `rerank_merge_v2.py`, preserving the `tags` field on every candidate.
5. Evaluate the reranked output with `benchmarks/longmemeval/evaluate_retrieval.py` (the canonical scorer; same invocation used in F14).

## Magnitude-smuggling guard

Per `docs/RETRACTION.md`. Strict grep before commit:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' <file>
```

The verbatim retraction sentence — `This release does not re-assert the retracted −10pp magnitude.` — must appear on its own line in the F15 result doc and in every commit body that touches result artefacts.

## Workload-validity gates (binding)

### Gate-A — workload validity

After running the sub-agent rerank:

- Dispatch success: 100/100 sub-agent calls return without error. Rejects silent batch failures that would leave gaps in the merged output.
- Ranked-ids permutation: for each query, the merged `retrieved_memories` ids are exactly the input top-100 ids, with no duplicates, no inventions, no drops. Rejects hallucinated ids, dedupe collapses, and accidental candidate dropping.
- Top-1 changed vs F14 baseline: ≥ 50 % of queries have a different top-1 session_id from the F14 BGE-base baseline (no-rerank). Rejects a no-op rerank where Opus merely echoes the bi-encoder order.
- Tags-passthrough: every output candidate's `tags` field is non-empty and exactly matches the input candidate's `tags` from `turn_bge_s_top100.jsonl`. Without this, a tags-stripping bug would silently zero out Gate-B hits (the canonical scorer `evaluate_retrieval.py:check_session_hit` matches via three paths; two of those three require `tags`).
- Batch wall-time logged: per-batch dispatch wall time is captured in the merge metadata, and the aggregate wall time across all 100 batches is reported in the result doc.

PASS = all five conditions. FAIL = fix and re-run; not a retraction trigger.

### Gate-B — proven value at R@5 (binding, HARD RETRACTION on FAIL)

F15-opus's R@5 — measured by `evaluate_retrieval.py` against the Sanderhoff-alt mirror of `longmemeval_s_cleaned.json` — must satisfy:

**R@5 ≥ 97.7 %** on `_s`.

The 97.7 threshold is gbrain v0.28.8's published 97.60 % R@5 on `_s` plus a 0.1 % margin. The Gate-B verdict binds on the canonical scorer `benchmarks/longmemeval/evaluate_retrieval.py` (which matches via three paths: `sid in tags` exact, `[Session: sid]` content marker, `any(sid in t for t in tags)` partial). Any inline scorer is a comparison helper only; if it diverges from `evaluate_retrieval.py`, the canonical number binds.

PASS = F15-opus `recall@5 ≥ 0.977` → conventional release update (CHANGELOG / README / ROADMAP / RETRACTION canonical docs updated to cite F15 numbers).
**FAIL** = F15-opus `recall@5 < 0.977` → **HARD RETRACTION** (see below).

#### Structural ceiling (required)

F14's R@100 on `_s` = 86.2 % is the absolute upper bound on F15's achievable R@5. A rerank can only reorder within the candidate pool; it cannot promote a session that does not appear in F14's top-100 into any top-K position. Since 13.8 % of answer-bearing sessions are absent from F14's top-100, the best reranker conceivable — one that perfectly orders the candidates — can achieve at most R@5 = 86.2 % on this pool.

86.2 < 97.7, therefore F15 cannot mathematically clear Gate-B from the F14 candidate pool alone.

The Gate-B threshold remains 97.7 because the project's discipline forbids retargeting gates to what an experiment can achieve. Lowering the threshold to fit within the structural ceiling is exactly the magnitude-smuggling pattern that `docs/RETRACTION.md` disciplines against. **F15's HARD RETRACTION is the expected outcome per this prereg.** The legitimate value F15 delivers is mechanism characterisation: measuring how much of the within-pool ranking gap (the 86.2 % R@100 − 42.0 % R@5 = 44.2-point within-pool gap) a maximally-equipped LLM-as-reranker closes, and comparing that to F9's lift (42.0 → 50.8 = 8.8-point gap closure on `_s`).

The path to actually clearing Gate-B is F15 + F16 combined: apply a strong reranker on top of a stronger bi-encoder that lifts R@100 closer to 100 % (closing the 13.8-point out-of-pool gap). F16 is queued in `ROADMAP-RESEARCH.md`.

## HARD RETRACTION arm (binding)

On Gate-B FAIL, the following actions are executed in full:

1. `data/lme_s/` deleted from disk (entire directory; gitignored data artefact).
2. `results/f15_subagent_rerank/` deleted from disk (all F15 output files).
3. `/tmp/rerank_f15_batches/` and `/tmp/rerank_f15_outputs/` deleted (the per-batch input + output JSON files).
4. No model-cache cleanup is required — F15 (revised) does not vendor any neural model. The pre-F14 model-cache (BGE-base, multilingual-e5-large, all-MiniLM-L6-v2) is untouched throughout F15 and requires no diff-manifest verification.
5. CHANGELOG / README / ROADMAP / RETRACTION canonical docs are NOT updated to cite F15 numbers.

The F15 result doc is retained as a negative-result audit trail regardless of Gate-B outcome.

## Cumulative-null acknowledgement

Per `docs/RETRACTION.md:94-113`. F15 continues the cumulative null trajectory established through v1.7.5/6/7/8 + v1.8.1 across the dlPFC goal-stack mechanism evaluations. F15 introduces (i) a staged `results/f15_subagent_rerank/` directory (gitignored), (ii) F15 prereg + result docs (this revision and the original `e4525b6`/`8a88880`), (iii) optionally an extended `rerank_split_v2.py` variant if the existing one is not parameterizable to top-100 / 1000-char (deferred to implementation; will reuse the existing script if possible). F15 reuses F14's `results/f14_baseline/turn_bge_s_top100.jsonl` as its candidate input; no new bi-encoder index is built; no neural reranker is vendored. The mechanism-null framing is unaffected.
