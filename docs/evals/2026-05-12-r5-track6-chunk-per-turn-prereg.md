# LongMemEval R@5 target — Track 6 (F13) chunk-per-turn ingestion — pre-registration

**Date:** 2026-05-12
**Predecessors:**
- F12 (e5-large + top-100, Gate-B FAIL at R@5 = 78.8). HARD RETRACTION executed; `hippo_store2/` restored to BGE-base.
- F11 + F9 stack (R@5 = 78.2, current deployable cross-track best, oracle split).

**Motivation:** Inspection of `data/longmemeval_oracle.json` after the F12 retraction reveals the structural pathology that ate every prior result: LongMemEval sessions are 14,292 chars median (≈3,500 tokens), 27,919 chars max. e5-large's max input is 514 tokens. Every prior track (F8 / F9 / F11 / F12) embeds the **first ~2 turns out of a 12-turn session** and truncates the rest. The answer-bearing turn (marked `has_answer: True` in the source data) is uniformly distributed across the 12 turns, so we have been embedding the answer only ~16% of the time. This is the largest unpulled lever in the cumulative-null inventory.

gbrain v0.28.8's published 97.60 on `_s` almost certainly chunks per turn (their setup uses `text-embedding-3-large`, but no embedder makes a 3,500-token session match a question if you only feed it the first 500 tokens). The split-mismatch and embedder-mismatch with gbrain remain (`_s` data is HF-gated and OpenAI API is host-blocked from this sandbox; both confirmed via `curl` in 2026-05-12 egress audit), so the gbrain figure remains NON-comparable. But the chunking lever is reachable independently and may move the oracle baseline materially.

This release does not re-assert the retracted −10pp magnitude.

---

## Split-mismatch disclosure (binding)

**This track measures `data/longmemeval_oracle.json` (3 sessions per haystack).** gbrain v0.28.8's 97.60 R@5 is on `longmemeval_s_cleaned.json` (~40 history sessions per haystack per the official LongMemEval README; the F12 result doc cited "50 sessions" — both are approximations of the same set, the LongMemEval README's ~40-session figure is the canonical number and is used here). The dataset is HF-gated and not reachable from this sandbox (verified via `curl -sSI https://huggingface.co/...` returning `403 host_not_allowed` on 2026-05-12). gbrain also uses OpenAI `text-embedding-3-large@1536` (api.openai.com host-blocked from this sandbox, same 2026-05-12 audit). The F13 result doc and any CHANGELOG / README mention must lead with this disclosure before any numerical comparison sentence. F13's binding comparison is against our own F11+F9 deployable baseline of 78.2 % oracle R@5, NOT gbrain.

## Goal

Replace session-level embedding (each 14k-char session → one 1024-dim vector with 80–90 % of content truncated) with **turn-level embedding** (each ~550-char turn → one 1024-dim vector, no truncation). At retrieval time: embed the query, score against all turn vectors, **max-pool by source session_id**, return the top-K sessions.

Concretely:
- Build a turn-level e5-large index over the 940 unique sessions in `hippo_store2/`. Estimated ≈11,000 turns (10,960 measured in the dataset; some duplicates collapse).
- For each LongMemEval question, embed the query with `query: <text>`, score every turn vector with cosine similarity, take the **max** score per `session_id`, sort sessions descending, output top-K.
- Score with the existing `benchmarks/longmemeval/evaluate_retrieval.py`, which iterates `retrieved_memories[*].tags` and counts a hit if any tag contains any element of `answer_session_ids`. Each turn-memory must therefore tag itself with its parent session_id (verbatim string match), preserving the existing scorer's matching contract without any evaluator change.

## Magnitude-smuggling guard

Per `docs/RETRACTION.md`. Strict grep before commit:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' <file>
```

The verbatim retraction sentence — `This release does not re-assert the retracted −10pp magnitude.` — must appear on its own line in the F13 result doc and in every commit body that touches result artefacts.

## Workload-validity gates (binding)

### Gate-A — workload validity

After building the turn-level index:

- Turn-count: total turns indexed ∈ [10,500, 11,500]. Lower bound rejects an off-by-one in chunk extraction; upper bound rejects double-counting.
- Each turn vector has dim == 1024 (e5-large hidden size).
- L2-norm of a 100-turn spot-check ∈ [0.999, 1.001].
- Every turn vector carries its parent `session_id` as a tag (verified by sampling 100 turns and confirming the tag matches the source).
- A "passage:" prefix is applied to each turn at embed time (smoke-check on a sample turn produces a different vector than the symmetric call). The same prefix code path used by F12's `prefixFor` helper.
- Session-coverage floor: every session_id in `longmemeval_oracle.json`'s 940-session universe must have at least one turn vector in the index. Verified via `len({tag.session_id for v in turn_index}) == 940`. Rejects a degenerate-collapse failure where dedupe drops a session entirely.

PASS = all five conditions. FAIL = fix and re-run; not a retraction trigger.

### Gate-B — proven value at R@5 (binding, HARD RETRACTION on FAIL)

Best F13 variant — defined as max(R@5) across (a) turn-level e5-large with max-pool aggregation, (b) the same plus a hybrid BM25 mix on the session-aggregated scores if time permits — must satisfy:

**R@5 ≥ 83.2 %** on `data/longmemeval_oracle.json`, scored by `benchmarks/longmemeval/evaluate_retrieval.py`.

The 83.2 threshold is the same as F12's Gate-B: F11+F9 deployable best (78.2) + 5 percentage points. F13 is not allowed to lower the bar after F12's FAIL.

PASS = best F13 variant `recall@5 ≥ 0.832`.
**FAIL** = best F13 variant `recall@5 < 0.832` → **HARD RETRACTION**:
- Revert any turn-level ingestion artifacts (the `benchmarks/longmemeval/data/turn_index.json` artifact is gitignored; delete it).
- Revert any `src/` changes if `benchmarks/longmemeval/chunk_per_turn_*.mjs` scripts ended up modifying `src/`; ideally F13 is a pure `benchmarks/` change so no `src/` revert is needed.
- The F13 result doc records FAIL verdict + per-K / per-type tables.
- CHANGELOG / README / ROADMAP do NOT cite F13 numbers.
- The deployable cross-track best remains F11+F9's 78.2.

### Stretch (NON-binding, NOT a target)

R@5 ≥ 95 % on the oracle split would represent "chunking captures most of the signal" and reduce the F12 ceiling argument (R@100 = 97.4) to almost lossless. NON-binding per this prereg.

## Failure handling

- **Gate-A FAIL**: chunking script bug. Fix and re-run.
- **Gate-B FAIL**: HARD RETRACTION (see above). The cumulative-null status of the dlPFC mechanism is unaffected.

## Cumulative-null acknowledgement

Per `docs/RETRACTION.md:94-113`. F13 adds (i) `benchmarks/longmemeval/chunk_per_turn_embed.mjs` for the one-off ingestion, (ii) `benchmarks/longmemeval/chunk_per_turn_retrieve.mjs` for the retrieval, (iii) the F13 prereg + result docs. F13 introduces no `src/` mechanism change — the embedding `prefixFor`, `preferredBackend`, and `poolingFor` helpers from F12 are reused untouched. The dlPFC goal-stack mechanism is independent of this evaluation.

## Outside-voice review

This prereg dispatched for isolated-context review before Task 1 (Gate-A index build). Result doc will undergo separate review before any CHANGELOG / README mention (none planned unless Gate-B PASS).

## Pre-registered cost and wall-time

- Turn-level embed: ~11,000 turns × ~150–300 ms per inference on CPU via `@huggingface/transformers` (turns are short, near the per-inference best case) → estimated 30–60 min wall.
- Turn-level retrieval: 500 queries × 11,000 turn-dot-products = 5.5 M cosine ops → estimated <1 min wall (in-memory float math).
- Aggregation + scoring: sub-second.
- Total cost: $0 in API spend.

## Provenance (to be completed during execution)

- Dataset: `data/longmemeval_oracle.json`, SHA-256 `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c`.
- Source store reference: `hippo_store2/` (940 sessions, F11-end BGE-base index, used only as the canonical 940-session set; F13 reads the haystack content directly from `longmemeval_oracle.json` to avoid any session-text-truncation artifact in the existing hippo store).
- Embedding model: `intfloat/multilingual-e5-large` via `Xenova/multilingual-e5-large`, vendored under F12 at `benchmarks/longmemeval/data/model-cache/Xenova/multilingual-e5-large/`. The F12 HARD RETRACTION reverted the *production* `hippo_store2/` index but left the vendored model on disk explicitly so this kind of follow-up is cheap.
- Turn-index artifact: `benchmarks/longmemeval/data/turn_index_e5.json` (gitignored), size ~45 MB estimated (11k × 1024 × FP32 + ids).
- Index-build wall time: filled in during Task 2.
- Retrieval wall time: filled in during Task 3.

## Outside-voice review trail

### Review (2026-05-12, isolated-context general-purpose subagent, Sonnet)

**Verdict:** PASS_WITH_NOTES (13/13). No required fixes. Three optional improvements applied:

1. Eval-contract explicit (Goal section now states the scorer's tag-matching rule).
2. Gate-A session-coverage floor added (rejects degenerate dedupe collapse).
3. ~40-session count reconciled with the LongMemEval README; F12's "50" approximation noted.

Controller authorised to proceed with Task 1 (turn-index build).

### Pre-execution prereg addendum (2026-05-12, controller)

**Embedder fallback authorized.** First-attempt e5-large turn-embed measured ~1.5 turn/s in this sandbox (the 4-core CPU saturates on the 24-layer XLM-R per-inference cost), implying ~2 h wall for 10,866 turns. Before the embed was 1% done, the controller pivoted to **BGE-base** (Xenova/bge-base-en-v1.5) for the first F13 variant: ~5.7 turn/s observed, ~32 min wall. BGE-base is the F11-era model with documented session-level performance (R@5 = 77.0 at session granularity; F11+F9 stack at 78.2). If BGE chunked clears Gate-B = 83.2, F13 publishes that and may not require an e5-large run. If BGE chunked misses 83.2, the e5-large turn-embed runs as a second variant (cost: ~2 h wall, no API spend).

Gate-B is unchanged at ≥ 83.2; "best F13 variant" now ranges over {BGE-base turn-level, e5-large turn-level if needed}. The embed-model swap from e5-large to BGE-base does not lower the Gate-B threshold and does not weaken the cumulative-null acknowledgement (no `src/` change in either case).

The pooling-dispatch is unchanged: BGE → CLS pooling, no prefix; e5 → mean pooling, "passage:" / "query:" prefix. Both pivots are covered by F12's `poolingFor` / `prefixFor` helpers (retained per the F12 retraction's dispatch-shape carve-out).
