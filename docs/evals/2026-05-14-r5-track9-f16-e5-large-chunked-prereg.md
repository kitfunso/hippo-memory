# LongMemEval R@5 target — Track 9 (F16) multilingual-e5-large chunked-turn on `_s` — pre-registration

**Date:** 2026-05-14
**Predecessors:** F14 baseline (BGE-base chunked-turn `_s`, R@5 = 42.0, R@100 = 86.2, Gate-B FAIL, HARD RETRACTION); F15 Opus rerank stacked on F14's top-100 (R@5 = 63.6, Gate-B FAIL, HARD RETRACTION); F12 multilingual-e5-large session-level oracle (R@5 = 78.8 with F9 stack, +0.6 delta over BGE-base session-level, Gate-B FAIL, HARD RETRACTION); F13 BGE-base chunked-turn oracle (R@5 = 86.8 with F9 stack, Gate-B PASS, v1.9.2 deployable).

**Motivation:** F15 demonstrated that the within-pool ranking gap closes ~50 % under a maximally-equipped LLM-as-reranker on the F14 candidate pool; the residual ~34 percentage-point gap to gbrain's 97.6 is now structurally attributable to the R@100 ceiling (F14's BGE-base places the answer-bearing session inside top-100 only 86.2 % of the time on `_s`). F16 attacks that ceiling by swapping the bi-encoder for the strongest GCS-reachable alternative (`Xenova/multilingual-e5-large`, 1024-dim, mean pooling, e5 prefix convention) while keeping the F13 chunked-turn granularity that lifted BGE-base by 8.6 percentage points on oracle. F12 already measured this embedder at session-level granularity on oracle and saw a 0.6-percentage-point delta — F16 tests whether the chunking lever amplifies that.

This release does not re-assert the retracted −10pp magnitude.

---

## Provenance disclosure (binding)

F16 inherits the same data source as F14/F15. The `_s` data used in F16 is re-acquired from `https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz` (decompressed SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`). The Sanderhoff-alt repo is an unaffiliated third-party personal GitHub account with no documented institutional or provenance link to the LongMemEval authors (xiaowu0162) or to the canonical HF release at `huggingface.co/datasets/xiaowu0162/longmemeval-cleaned`. There is no signed chain-of-custody from HF to this mirror. The only integrity signal available is the 500/500 question_id match with our independently verified `data/longmemeval_oracle.json` (SHA-256 `821a2034a...`) plus the canonical-schema match — same posture as F14 and F15. F16 introduces no new data source.

## Embedder selection rationale (binding)

Pre-flight on 2026-05-14 enumerated fastembed's text-embedding catalog and confirmed only six models are GCS-reachable from this sandbox (HF Hub blocked, all known HF mirrors blocked, all PyPI alternatives wrap HF as first-line source). Of those six, only `intfloat/multilingual-e5-large` (1024-dim, 2.24 GB) is structurally stronger than the F14 baseline `BAAI/bge-base-en-v1.5` (768-dim, 0.21 GB). `BAAI/bge-large-en-v1.5`, `mxbai-embed-large-v1`, `e5-large-v2`, `gte-large`, and all reranker-class cross-encoders are HF-only and structurally unreachable from this sandbox. F16 is therefore the only locally-runnable embedder-swap track available for `_s`; further embedder lever experiments are blocked on either (a) HF egress widening, (b) a user-supplied pre-downloaded model tarball, or (c) OpenAI API egress for `text-embedding-3-large` (gbrain's embedder). All three are listed as follow-ups in `ROADMAP-RESEARCH.md`.

## Embedder mismatch with gbrain (binding)

gbrain v0.28.8 uses OpenAI `text-embedding-3-large@1536` (`api.openai.com` host-blocked, confirmed 2026-05-11 + 2026-05-12 egress audits). F16 uses `Xenova/multilingual-e5-large` (335M params, 1024-dim, mean pooling, e5 prefix convention; vendored via Qdrant fastembed GCS, weights present on disk from F12's HARD RETRACTION carve-out). gbrain's published gbrain-vector adapter (pure-embedding ablation) scored 97.40 % R@5 on `_s`; the embedder is the dominant factor in gbrain's headline. **F16 measures multilingual-e5-large chunked-turn baseline on `_s`; gbrain measures text-embedding-3-large + sessions-as-chunks + RRF on `_s`. The split is matched; the embedder is not.** The chunking lever F13 contributed (and F14/F15 inherited) is preserved here — F16 is a 1-axis swap from F14 (the bi-encoder model), holding all other pipeline knobs constant. F16 includes no LLM-reranker stage (see Goal section for the cost-of-information rationale).

## Goal

Apply F14's chunked-turn retrieval pipeline with multilingual-e5-large substituted for BGE-base. **Scope: baseline-only — no LLM-reranker stage in F16.** Concretely:

1. Build a chunked-turn index over all 19,195 unique sessions in `_s`, embedding each turn separately with `passage: <content>` and L2-normalising.
2. For each of the 500 queries, embed with `query: <text>`, compute cosine similarity against every turn vector, max-pool by `session_id`, and retain the top-100 sessions per query.
3. Evaluate the resulting retrieval JSONL with `benchmarks/longmemeval/evaluate_retrieval.py` (the canonical scorer; same invocation as F14/F15).
4. Gate-B verdict is unambiguously F16 baseline R@5 from the canonical scorer.

The Opus-rerank lever was already characterised end-to-end by F15 (+13 percentage-point lift over F14+F9-Sonnet at top-100, structured rubric, 1000-char context). Stacking the same lever on F16's top-100 would cost ~$300–500 in Opus credits and ~2–3 hours wall time to confirm a Gate-B FAIL the priors predict; the cost-of-information value is low. If F16 baseline produces a surprising result (e.g. R@5 ≥ 70 or R@100 ≥ 95), a follow-up `F16b` track can stack F15-style rerank on F16's pool under a fresh prereg with a fresh Gate-B verdict. The current F16 prereg pre-commits to baseline-only and does not invoke max-of-variants logic.

## Magnitude-smuggling guard

Per `docs/RETRACTION.md`. Strict grep before commit:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' <file>
```

The verbatim retraction sentence — `This release does not re-assert the retracted −10pp magnitude.` — must appear on its own line in the F16 result doc and in every commit body that touches result artefacts.

## Workload-validity gates (binding)

### Gate-A — workload validity

After building the index and running retrieval:

- **Model load:** the multilingual-e5-large weights load from `benchmarks/longmemeval/data/model-cache/Xenova/multilingual-e5-large/` (the F12 HARD RETRACTION carve-out cache). Rejects silent HF-fallback that would fail mid-run.
- **Index shape:** the chunked-turn index has 199,509 ± 100 turn vectors (matches F14's BGE-base index turn count to within 0.1 %, confirming the chunking pass is deterministic across embedders), each at dimension 1024 (e5-large native), with L2-norms in [0.9999, 1.0001] for ≥ 99 % of vectors. Rejects accidental session-level fallback, dimension mismatch, and unnormalised-vector bugs.
- **Retrieval completeness:** all 500 questions have a retrieval result with exactly 100 candidate sessions each. Rejects silent truncation or skipped queries.
- **Tags passthrough:** every retrieved candidate's `tags` field is non-empty and contains the session_id. Without this, a tags-stripping bug would silently zero out Gate-B hits (the canonical scorer `evaluate_retrieval.py:check_session_hit` matches via three paths; two of those three require the `tags` field).
- **Top-1 different from F14 BGE-base:** for at least 30 % of the 500 queries, F16's top-1 session_id differs from F14's top-1. Rejects a no-op embedder swap where the new embedder produces the same ranking as BGE-base. The 30 % threshold is lower than F15's 50 % because the embedder lever is structurally smaller than the LLM-rerank lever — F12 saw only +0.6pp at session-level, so a low top-1-change rate is plausible even for a successful swap.

PASS = all five conditions. FAIL = fix and re-run; not a retraction trigger.

### Gate-B — proven value at R@5 (binding, HARD RETRACTION on FAIL)

F16's only measured variant is the baseline (e5-large chunked-turn, no rerank), measured by `evaluate_retrieval.py` against the Sanderhoff-alt mirror of `longmemeval_s_cleaned.json`, must satisfy:

**R@5 ≥ 97.7 %** on `_s`.

The 97.7 threshold is gbrain v0.28.8's published 97.60 % R@5 on `_s` plus a 0.1 % margin. The Gate-B verdict binds on the canonical scorer; if any inline scorer diverges, the canonical script's number is binding.

PASS = F16 baseline `recall@5 ≥ 0.977` → conventional release update (CHANGELOG / README / ROADMAP / RETRACTION canonical docs updated to cite F16 numbers).
**FAIL** = F16 baseline `recall@5 < 0.977` → **HARD RETRACTION** (see below).

#### Structural ceiling (acknowledged)

F14's R@100 on `_s` = 86.2. If F16's R@100 turns out to be ≤ 86.2, then F16 has not lifted the embedder ceiling and Gate-B is structurally still 86.2 < 97.7 ⇒ unreachable. If F16's R@100 lifts to, say, 92, the structural ceiling moves to 92 — still < 97.7. **A R@100 lift from 86.2 to any value strictly below 97.7 does NOT change the Gate-B verdict; the 97.7 threshold is immovable.** To clear Gate-B from this sandbox with a 1-axis embedder swap alone, F16's R@100 would need to reach ≥ 97.7 in the baseline (since rerank only re-orders within the pool, the post-rerank R@5 is bounded above by the pre-rerank R@100). MTEB Retrieval delta from BGE-base-en-v1.5 to multilingual-e5-large is ~0–2 percentage points on standard benchmarks; LongMemEval `_s` is non-standard (mostly user-generated chat content, 48 distractors per haystack) so the delta could in principle be larger or smaller, but the prior is small. **F16's Gate-B FAIL is the expected outcome per this prereg.**

The legitimate value F16 delivers is mechanism characterisation: measuring whether the chunking lever amplifies the embedder swap (F16 R@100 vs F14 R@100, and F16 R@5 vs F14 R@5). **Important comparability caveat:** F12 measured `multilingual-e5-large` at session-level granularity on the *oracle* split, observing a 0.6-percentage-point R@5 delta over BGE-base. F16 measures the same embedder at chunked-turn granularity on the `_s` split. The two configurations differ on TWO axes (split and granularity); the F12 vs F16 delta comparison is therefore directional, not strictly apples-to-apples. The F15-vs-F16 comparison (within-pool LLM rerank vs stronger embedder, both on `_s`) is also out of scope here — F16 does not stack an LLM rerank stage; if F16 baseline produces a result that would benefit from the LLM-rerank lever, a follow-up `F16b` track under its own prereg can measure that.

**F16 is a single-configuration track**, not a sweep across embedder variants. The pre-flight ruled out `bge-large-en-v1.5`, `mxbai-embed-large-v1`, `e5-large-v2`, and `gte-large` (all HF-only), leaving exactly one GCS-reachable stronger embedder to test. The result doc must not imply an ablation space was considered and rejected; the constraint is purely a sandbox-reachability artefact.

The path to actually clearing Gate-B from this sandbox is blocked on either HF egress widening (enabling `bge-large-en-v1.5` or `mxbai-embed-large-v1`), a user-supplied pre-downloaded model tarball, or OpenAI API egress for `text-embedding-3-large`. All three are queued in `ROADMAP-RESEARCH.md`. **F16 is therefore the last locally-executable embedder-swap track on `_s` until at least one of those three sandbox constraints relaxes.**

## HARD RETRACTION arm (binding)

On Gate-B FAIL, the following actions are executed in full:

1. `data/lme_s/` deleted from disk (entire directory; gitignored data artefact).
2. `results/f16_e5_large/` deleted from disk (all F16 output files).
3. `benchmarks/longmemeval/data/turn_index_e5_s.json.jsonl` and `benchmarks/longmemeval/data/turn_index_e5_s.json.partial.jsonl` deleted (the ~1–2 GB F16 chunked-turn index and any partial-build scaffold; both gitignored).
4. `/tmp/f16_build.log` and `/tmp/f16_retrieve.log` deleted. (No `/tmp/rerank_f16_*` directories under the baseline-only scope.)
5. `benchmarks/longmemeval/data/model-cache/Xenova/multilingual-e5-large/` is **retained**, NOT deleted. These weights pre-date F16 (vendored by F12 in commit history pre-dating this plan) and were preserved by the F12 HARD RETRACTION carve-out. They are not newly downloaded by F16.
6. CHANGELOG / README / ROADMAP / RETRACTION canonical docs are NOT updated to cite F16 numbers.

The F16 result doc is retained as a negative-result audit trail regardless of Gate-B outcome.

## Cumulative-null acknowledgement

Per `docs/RETRACTION.md:94-113`. F16 continues the cumulative null trajectory established through v1.7.5/6/7/8 + v1.8.1 across the dlPFC goal-stack mechanism evaluations. F16 introduces (i) a staged `results/f16_e5_large/` directory (gitignored), (ii) a chunked-turn index `benchmarks/longmemeval/data/turn_index_e5_s.json.jsonl` (gitignored, ~1–2 GB), (iii) F16 prereg + result docs. F16 reuses F14's `chunk_per_turn_embed.mjs` + `chunk_per_turn_retrieve.mjs` (already parameterised for both bge and e5 model families per F13's original design); no `src/` changes. The mechanism-null framing is unaffected.
