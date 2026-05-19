# LongMemEval R@5 target — Track 7 (F14) F13 pipeline on `_s` split — pre-registration

**Date:** 2026-05-12
**Predecessors:** F13 (chunk-per-turn ingestion, oracle R@5 = 86.8, Gate-B PASS); v1.9.2 release.

**Motivation:** Across F8–F13 we measured retrieval R@5 on `data/longmemeval_oracle.json` (the easier 3-sessions-per-haystack split) because the standard `_s` split (~48 sessions per haystack, 500 questions, 19,195 unique sessions) is HuggingFace-distributed and the HF Hub was confirmed host-blocked from this sandbox on 2026-05-11 and 2026-05-12 egress audits. F13's R@5 = 86.8 on oracle is therefore NOT directly comparable to gbrain v0.28.8's published 97.60 % R@5 on `_s`.

A renewed egress hunt on 2026-05-12 located a reachable mirror of the standard split: `https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz` (74 MB compressed; 265 MB after gunzip; SHA-256 of the decompressed JSON: `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`). The mirror is a Chinese-translation pipeline project that committed the English source JSON gzipped to stay within GitHub's 100 MB per-file limit. Structure verified: 500 questions matching our oracle question_ids one-to-one, ~48 sessions per haystack (min 38, p95 53, max 62), 19,195 unique sessions of which 940 are answer-bearing and 18,255 are distractors.

This release does not re-assert the retracted −10pp magnitude.

---

## Provenance disclosure (binding)

The `_s` data used in this track is sourced from `https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz` (decompressed SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`). The mirror's `README.md` states it is the English source for a translation pipeline; the file matches the canonical schema described in the official LongMemEval README (`question_id`, `answer_session_ids`, `haystack_session_ids`, `haystack_sessions`, etc.) and shares all 500 question_ids with our verified `data/longmemeval_oracle.json` (SHA-256 `821a2034a...`).

**The Sanderhoff-alt repo is an unaffiliated third-party personal GitHub account with no documented institutional or provenance link to the LongMemEval authors (xiaowu0162) or to the canonical HF release at `huggingface.co/datasets/xiaowu0162/longmemeval-cleaned`. There is no signed chain-of-custody from HF to this mirror.** The only integrity signal available to us is the 500/500 question_id match with our independently verified oracle file plus the canonical-schema match. This is NOT a verified-against-HF copy (HF Hub is host-blocked); the F14 result doc must label all numbers as "measured against the Sanderhoff-alt mirror" and note that if the mirror was tampered with relative to the canonical xiaowu0162/longmemeval-cleaned release (e.g. swapped distractor sessions, added easy distractors that artificially inflate recall), the F14 numbers are conditional on the mirror's integrity.

## Embedder mismatch with gbrain (binding)

gbrain v0.28.8 uses OpenAI `text-embedding-3-large@1536` (`api.openai.com` host-blocked from this sandbox, confirmed 2026-05-11 + 2026-05-12 egress audits). F14 uses `Xenova/bge-base-en-v1.5` (the F11/F13 embedder; 768-dim CLS pooling, vendored locally via the Qdrant fastembed GCS bucket). gbrain's published gbrain-vector adapter (their pure-embedding ablation) scored 97.40 % R@5 on `_s`; the embedder is the dominant factor in gbrain's headline. Any F14 number below 97.60 may reflect the embedder gap rather than a pipeline gap. **F14 measures BGE-base + chunked turn-level retrieval + sub-agent rerank on `_s`; gbrain measures text-embedding-3-large + sessions-as-chunks + RRF on `_s`. The split is now matched (a first); the embedder is not.**

## Goal

Apply the F13 chunked-turn pipeline (`benchmarks/longmemeval/chunk_per_turn_embed.mjs` + `chunk_per_turn_retrieve.mjs`) to the `_s` split. Concretely:

1. Build a BGE-base turn-level index over the 19,195 unique sessions in `_s`. Estimated 199,509 unique turns (10,866 of which are already embedded from F13's oracle index — same 940 answer-bearing sessions with the same content). Estimated 188,643 NEW turns to embed; at the F13-measured rate of 5.7 turn/s, ~9.3 h wall time on the 4-core CPU.
2. For each LongMemEval question, embed the query with BGE-base, score every turn vector, max-pool by source `session_id`, return top-100 sessions.
3. Apply F9 sub-agent rerank on the top-20 of each query's top-100 — same pattern as F13+F9 on oracle.
4. Score with `benchmarks/longmemeval/evaluate_retrieval.py`.

Both variants — (a) F14 baseline (BGE-base chunked + max-pool, no rerank) and (b) F14 + F9 stack (top-20 reranked) — are always run end-to-end and individually tabled in the result doc, regardless of Gate-B outcome. Gate-B's "best F14 variant" is selected post-hoc from these two; the result doc reports both numbers, the per-K and per-type breakdowns for each, and which variant cleared (or didn't clear) the 97.7 threshold.

## Magnitude-smuggling guard

Per `docs/RETRACTION.md`. Strict grep before commit:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' <file>
```

The verbatim retraction sentence — `This release does not re-assert the retracted −10pp magnitude.` — must appear on its own line in the F14 result doc and in every commit body that touches result artefacts.

## Workload-validity gates (binding)

### Gate-A — workload validity

After building the turn-level index for `_s`:

- Turn count: total turns indexed ∈ [195,000, 205,000]. Lower bound rejects off-by-one in chunk extraction; upper bound rejects duplication.
- Each turn vector has dim == 768 (BGE-base).
- L2-norm of a 100-turn spot-check ∈ [0.999, 1.001].
- Session-coverage floor: `len({tag.session_id for v in turn_index}) == 19195`. Rejects degenerate dedupe collapse.
- Every turn vector carries its parent `session_id` as a tag (verbatim string match), preserving `evaluate_retrieval.py`'s `check_session_hit` matching contract.

PASS = all five conditions. FAIL = fix and re-run; not a retraction trigger.

### Gate-B — proven value at R@5 (binding, HARD RETRACTION on FAIL)

The F14 best variant — defined as max(R@5) across (a) F14 baseline (BGE-base chunked, hybrid+max-pool to session), (b) F14 + F9 stack (sub-agent rerank on top-20) — measured by `evaluate_retrieval.py` against the Sanderhoff-alt mirror of `longmemeval_s_cleaned.json`, must satisfy:

**R@5 ≥ 97.7 %** on `_s`.

The 97.7 threshold is gbrain v0.28.8's published 97.60 % R@5 on `_s` plus a 0.1 % margin to count as "genuinely besting" rather than within-noise. The user explicitly directed targeting "besting gbrain 97.6"; 97.7 is the smallest decisive margin.

PASS = best F14 variant `recall@5 ≥ 0.977`.
**FAIL** = best F14 variant `recall@5 < 0.977` → **HARD RETRACTION**:
- Revert any data artefacts: delete the staged `data/lme_s/` directory and the `benchmarks/longmemeval/data/turn_index_bge_s.json` index.
- The F14 result doc records the FAIL verdict, per-K, per-type tables.
- CHANGELOG / README / ROADMAP / RETRACTION docs are NOT updated to cite F14 numbers.
- The deployable cross-track best remains F13+F9 stack on oracle at R@5 = 86.8.
- The mirror's existence is noted in the result doc (it's a reachable resource that costs nothing to leave on disk for future tracks), but the F14 numbers themselves are descriptive only.

### Stretch (NON-binding, NOT a target)

R@5 ≥ 99 % on `_s` would represent the structural ceiling for chunked-turn retrieval against BGE-base. Achievable only if the BGE-base embedder genuinely distinguishes the answer-bearing turn from 18,255 distractor sessions. NON-binding per this prereg.

## Failure handling

- **Gate-A FAIL:** index build bug. Fix and re-run. Not a retraction trigger.
- **Gate-B FAIL:** HARD RETRACTION (see above). The deployable best remains F13+F9 on oracle.

## Cumulative-null acknowledgement

Per `docs/RETRACTION.md:94-113`. F14 introduces (i) a staged `data/lme_s/longmemeval_s_cleaned.json` (gitignored), (ii) a `benchmarks/longmemeval/data/turn_index_bge_s.json` index (gitignored, ~3.4 GB based on F13 oracle's 14 MB-per-1k-turn ratio), (iii) F14 prereg + result docs. F14 reuses F13's `chunk_per_turn_{embed,retrieve}.mjs` with a small `--data` flag addition (the F13 versions hard-code `data/longmemeval_oracle.json`; F14 adds a fourth positional CLI argument so the data path is configurable). This is a `benchmarks/` change, not a `src/` change; the mechanism-null framing is unaffected. The dlPFC goal-stack mechanism is independent of this evaluation.

## Outside-voice review

This prereg is dispatched for isolated-context review before Task 1 (Gate-A index build). The result doc will undergo a separate review before any CHANGELOG / README mention (none planned unless Gate-B PASS).

## Pre-registered cost and wall-time

- `_s` ingestion: zero API spend (already fetched from GitHub mirror).
- BGE-base turn-level embed: 188,643 new turns × ~0.176 s/turn (F13 rate) ≈ **9.3 h wall time on 4-core CPU**. This is the dominant cost; F14 will run the embed in the background and the controller may close-and-resume the session before retrieval/rerank.
- Retrieval: 500 queries × ~200k turn dot-products ≈ 2-3 min wall (in-memory float math).
- F9 sub-agent rerank: 50 sub-agent dispatches (same pattern as F13).
- Total estimated cost: $0 API spend; ~9.5-10 h controller wall time end-to-end.

## Provenance (to be completed during execution)

- Dataset: `data/lme_s/longmemeval_s_cleaned.json`, SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, source URL `https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz`.
- Source mirror README cite: `https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/README.md` (states the .json.gz file is the English source for a Chinese-translation pipeline).
- Embedder: `Xenova/bge-base-en-v1.5` via Qdrant fastembed GCS, CLS pooling, no prefix (matches F13).
- Embed driver: `benchmarks/longmemeval/chunk_per_turn_embed.mjs Xenova/bge-base-en-v1.5 benchmarks/longmemeval/data/turn_index_bge_s.json data/lme_s/longmemeval_s_cleaned.json`.
- Retrieve driver: `benchmarks/longmemeval/chunk_per_turn_retrieve.mjs benchmarks/longmemeval/data/turn_index_bge_s.json results/f14_baseline/turn_bge_s_top100.jsonl 100 data/lme_s/longmemeval_s_cleaned.json`.
- Index-build wall time: filled in during Task 2.
- Retrieval wall time: filled in during Task 3.
- F9 rerank pattern: same as F13 (50 batches × 10 queries × 20 candidates × ≤ 600 chars/candidate).

## Outside-voice review trail

### Review (2026-05-12, isolated-context general-purpose subagent, Sonnet)

**Verdict:** PASS_WITH_NOTES (12/14 PASS, 2 required fixes applied, 1 optional improvement applied).

Per-check summary:

1. Verbatim retraction sentence on own line — PASS.
2. Strict magnitude-smuggling grep declared — PASS.
3. Provenance disclosure (source SHA, not-HF-verified, tamper consequence) — PASS, strengthened in revision.
4. Embedder-mismatch disclosure binding — PASS.
5. Gate-A operational (5 conditions) — PASS.
6. Gate-B 97.6 + 0.1 = 97.7 — PASS.
7. HARD RETRACTION arm concrete (3 named reverts; CHANGELOG/README/ROADMAP/RETRACTION not updated) — PASS.
8. Stretch NON-binding — PASS.
9. Cumulative-null cite `docs/RETRACTION.md:94-113` — PASS.
10. Outside-voice clauses present — PASS.
11. Provenance fields complete — PASS.
12. Wall-time estimate plausible (188k × 0.176 s = 9.3 h on 4-core CPU) — PASS.
13. F14 framed as continuing F13 pipeline — PASS, `--data` flag clarification applied.
14. F14 baseline vs F14+F9 delineation + Sanderhoff-alt mirror framing — required fixes applied this revision:
   - Added explicit sentence that the Sanderhoff-alt repo is an unaffiliated third-party personal account with no provenance chain to the canonical HF release; SHA-256 + question_id match is the sole integrity signal.
   - Added explicit sentence that both F14 baseline and F14+F9 stack are always run and individually tabled regardless of Gate-B outcome.
   - Clarified `--data` flag is a small benchmarks-side script addition (not a pre-existing pass-through), preserving the "no src/ change" framing accurately.

Controller authorised to proceed with Task 1 (data staging + script flag addition + index build).
