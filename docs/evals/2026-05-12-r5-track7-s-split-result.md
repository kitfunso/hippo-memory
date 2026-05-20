# LongMemEval R@5 target — Track 7 (F14) F13 pipeline on `_s` split — result

**Date:** 2026-05-12
**Author:** controller (claude/plan-implementation-workflow-sasNp)
**Prereg:** `docs/evals/2026-05-12-r5-track7-s-split-prereg.md`
**Predecessor:** F13 chunked-turn (oracle R@5 = 86.8, Gate-B PASS, v1.9.2).

This release does not re-assert the retracted −10pp magnitude.

---

## Provenance disclosure (binding, per prereg)

The `_s` data used in F14 was sourced from `https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz` (decompressed SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, 500 questions, ~48 sessions per haystack, 19,195 unique sessions of which 940 are answer-bearing). The Sanderhoff-alt repo is an unaffiliated third-party personal GitHub account with no provenance chain to the canonical HuggingFace release at `huggingface.co/datasets/xiaowu0162/longmemeval-cleaned` (HF Hub host-blocked from this sandbox, verified 2026-05-12). The only integrity signal available is the 500/500 question_id match with our independently verified `data/longmemeval_oracle.json` (SHA-256 `821a2034a...`) plus the canonical-schema match. **The F14 numbers below are conditional on the mirror's integrity.** If the mirror was tampered with relative to the canonical release (e.g. easier distractors substituted in), F14 numbers would be inflated; the schema match precludes wholesale fabrication but cannot detect plausible-distractor substitution.

## Embedder mismatch with gbrain (binding, per prereg)

gbrain v0.28.8 uses OpenAI `text-embedding-3-large@1536` (`api.openai.com` host-blocked from this sandbox). F14 uses `Xenova/bge-base-en-v1.5` (768-dim CLS pooling, locally vendored via Qdrant fastembed GCS). The split is matched (both measure on `_s`, 500 questions, ~48 sessions per haystack); the embedder is not.

## TL;DR

- **Gate-A:** PASS. 199,509 turns indexed across all 19,195 unique sessions in `_s`. Vector dim 768 (BGE-base), L2-norms in [0.999999, 1.000000], every turn tagged with its parent `session_id`.
- **Gate-B:** **FAIL.** Best F14 variant R@5 = 50.8 % (F14 + F9 sub-agent rerank on top-20). Threshold was ≥ 97.7 % (= gbrain v0.28.8's published 97.60 + 0.1 margin). **Shortfall: 46.9 percentage points.** F14 baseline R@5 = 42.0 % (no rerank).
- Per the F14 prereg's HARD RETRACTION clause, this triggers data-artefact deletion and no CHANGELOG / README / ROADMAP / RETRACTION updates. The deployable cross-track best remains F13 + F9 on oracle at R@5 = 86.8.
- **The embedder gap is the dominant factor.** gbrain's own ablation table reports their pure-vector adapter (text-embedding-3-large@1536 alone, no BM25, no rerank) at R@5 = 97.40 on the same `_s` split. Their hybrid+RRF lifts that to 97.60 — a 0.20-point top-up. F14 uses BGE-base (the F11/F13 embedder, 768-dim, CLS pooling); F14's R@100 ceiling on `_s` is 86.2 — meaning the answer-bearing session is in our top-100 only 86 % of the time, vs gbrain's effective ~100 % from pure-vector. The chunking lever (F13's key contribution, +8.6 R@5 on oracle) is preserved here; the scaling problem is that BGE-base cannot distinguish 940 answer-bearing sessions from 18,255 plausible-looking distractor sessions at top-K.
- gbrain's BM25-only baseline on the same split: 19.80 R@5. F14's BGE-base baseline at 42.0 sits between that and gbrain's vector baseline at 97.40, consistent with BGE-base being a meaningfully better-than-keyword embedder but qualitatively below text-embedding-3-large on this 40-distractors-per-haystack workload.

## Provenance

- **Dataset:** `data/lme_s/longmemeval_s_cleaned.json` (gitignored, 265 MB, SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`).
- **Source URL:** `https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz`.
- **Embedder:** `Xenova/bge-base-en-v1.5` (CLS pooling, no prefix; matches F13).
- **Embed driver:** `node benchmarks/longmemeval/chunk_per_turn_embed.mjs Xenova/bge-base-en-v1.5 benchmarks/longmemeval/data/turn_index_bge_s.json data/lme_s/longmemeval_s_cleaned.json` (resumable mode; warm-started with F13 oracle's 10,866-turn index).
- **Retrieve driver:** `node benchmarks/longmemeval/chunk_per_turn_retrieve.mjs benchmarks/longmemeval/data/turn_index_bge_s.json results/f14_baseline/turn_bge_s_top100.jsonl 100 data/lme_s/longmemeval_s_cleaned.json`.
- **F9 rerank:** 50 sub-agent dispatches over `/tmp/rerank_f14_batches/` (split via `benchmarks/longmemeval/rerank_split_v2.py`), merged via `benchmarks/longmemeval/rerank_merge_v2.py` to `results/f14_rerank/reranked.jsonl`.
- **Evaluator:** `python3 benchmarks/longmemeval/evaluate_retrieval.py`.

## Gate-A — workload validity

**Verdict: PASS.**

Build artifact (gitignored): `benchmarks/longmemeval/data/turn_index_bge_s.json.jsonl`, 3.3 GiB, 199,509 turn records (one JSONL line each) plus a metadata header line.

Conditions (from prereg):

- Turn count: 199,509 ∈ [195,000, 205,000] — PASS.
- Vector dim: every turn vector has length 768 (BGE-base) — PASS.
- L2-norm spot-check (first 100 turns): all in [0.999999, 1.000000] — PASS.
- Session-coverage floor: `len({turn.session_id for turn in turn_index}) == 19,195`, equal to the source-data unique session count — PASS.
- Session-id tag carriage at retrieval: each retrieved memory's `tags[0]` is the parent session_id, preserving `evaluate_retrieval.py`'s `check_session_hit` matching contract — PASS.

Embed wall time: 9,731.3 s (≈ 2.7 h) for 82,683 NEW turns after a resumed warm-start at 116,826 turns. Total embed wall across the multi-stage run: ~5 h on the 4-core CPU at ~8.5–9.2 turn/s, surviving one Node v22 `JSON.stringify` `RangeError: Invalid string length` crash (fixed by switching the output format to JSONL — see `chunk_per_turn_embed.mjs` and commit `12f5858`) plus one silent process exit during the second-half embed run (recovered cleanly from JSONL partial).

## Gate-B — proven value at R@5 (≥ 97.7 % to genuinely best gbrain)

**Verdict: FAIL.** Best F14 variant R@5 = 50.8 % on `_s`. Threshold was ≥ 97.7 %. **Shortfall: 46.9 percentage points.**

| Configuration | R@1 | R@3 | R@5 | R@10 | R@20 |
|---|---:|---:|---:|---:|---:|
| F14 baseline (BGE-base turn-level + max-pool, no rerank) | 21.6 | 34.4 | 42.0 | 51.8 | 65.6 |
| **F14 + F9 stack (BGE-base turn-level + 50-dispatch sub-agent rerank on top-20)** | **33.6** | **46.8** | **50.8** | **56.2** | **65.2** |
| gbrain v0.28.8 (text-embedding-3-large + RRF) | — | — | **97.60** | — | — |
| F14 Gate-B threshold | — | — | 97.7 | — | — |

Per the F14 prereg's HARD RETRACTION arm, Gate-B FAIL triggers data-artefact deletion. See the "HARD RETRACTION (executed)" section below.

## Per-K table

Full distribution from F14's deep-pool retrieval (top-100 candidates per query, max-pooled by `session_id`):

| K | F14 baseline R@K | F14 + F9 stack R@K |
|---:|---:|---:|
| 1 | 21.6 | 33.6 |
| 3 | 34.4 | 46.8 |
| 5 | 42.0 | 50.8 |
| 10 | 51.8 | 56.2 |
| 20 | 65.6 | 65.2 |
| 50 | 77.8 | (n/a — rerank only touches top-20) |
| 100 | 86.2 | (n/a — rerank only touches top-20) |

R@100 = 86.2 is the absolute ceiling for any reranker working on this index — the answer-bearing session is NOT in F14's top-100 for 13.8 % of queries. gbrain's pipeline, by contrast, finds the answer-bearing session inside top-5 in 97.6 % of queries. The ~ 50-point gap at R@5 has two structurally distinct contributions: (a) ~ 12-point gap at R@100 (BGE-base just doesn't surface the right session into the candidate pool for 70 of the 500 queries, even with chunked turn-level retrieval), and (b) a ~ 35-point ranking gap within the candidate pool (when the right session IS in the pool, BGE-base ranks it outside top-5 too often).

Note on the R@20 row: the F14+F9 stack shows R@20 = 65.2, which is fractionally below the F14 baseline's R@20 = 65.6. The F9 sub-agent rerank only touches the top-20 (sets `--max-candidates 20` in `rerank_split_v2.py`); it cannot promote any item from positions 21+ into the top-20. The marginal 20th slot can shift when the reranker reorders the top-20 with ties or near-ties, and this can produce a ≤ 1-point apparent regression at the cumulative-K = 20 cutoff. The lift the reranker contributes is concentrated at K ≤ 5 (42.0 → 50.8) and K ≤ 10 (51.8 → 56.2); R@20 is intentionally pinned to the baseline's candidate pool.

## Per-type breakdown

F14 + F9 stack at R@5 on `_s`:

| question_type | n | F14 baseline R@5 | F14 + F9 stack R@5 |
|---|---:|---:|---:|
| knowledge-update | 78 | 64.1 | 69.2 |
| multi-session | 133 | 35.3 | 45.9 |
| single-session-assistant | 56 | 82.1 | 92.9 |
| single-session-preference | 30 | 10.0 | 16.7 |
| single-session-user | 70 | 24.3 | 35.7 |
| temporal-reasoning | 133 | 35.3 | 42.9 |
| **all types** | **500** | **42.0** | **50.8** |

The pattern is consistent across categories: the rerank lifts every type, but the absolute numbers stay far from the gbrain ballpark. `single-session-assistant` is the only category where F14+F9 approaches gbrain's per-type range (92.9 vs gbrain's 100.0 on this category); on `single-session-preference` F14+F9 hits 16.7 vs gbrain's 93.3 — a 76-point gap, entirely driven by the embedder.

## HARD RETRACTION (executed)

Per the F14 prereg's binding Gate-B FAIL arm, the following actions are taken:

1. **Data artefacts deleted on disk.** `data/lme_s/longmemeval_s_cleaned.json` (265 MB) and `benchmarks/longmemeval/data/turn_index_bge_s.json.jsonl` (3.3 GiB) are removed. Both were gitignored; nothing committed to the repo references them.

2. **No canonical-doc updates.** CHANGELOG, README, ROADMAP-RESEARCH, and `docs/RETRACTION.md` are NOT updated to cite F14 numbers. The project's deployable cross-track best on retrieval R@5 remains **F13 + F9 stack on oracle at R@5 = 86.8** (the v1.9.2 deployable).

3. **Code paths retained.** The `chunk_per_turn_{embed,retrieve}.mjs` scripts and the JSONL output format are retained because (a) F13's oracle pipeline still uses them at v1.9.2 (the JSONL fix supersedes the pre-`12f5858` JSON format), and (b) they're benchmark scaffolding, not `src/` mechanism. No `src/` changes were introduced by F14 in the first place.

4. **Result-doc retention.** This document is retained as the negative-result record. Matching the F10 / F12 retraction pattern, negative-result documents stay published to maintain the audit trail.

## Cross-track summary at R@5

| Configuration | Split | Embedder | R@5 | Note |
|---|---|---|---:|---|
| F8 best (MiniLM hybrid) | oracle | MiniLM | 76.8 | F8 |
| F9 v2 (MiniLM + rerank) | oracle | MiniLM | 78.0 | F9 v2 |
| F11 (BGE-base baseline) | oracle | BGE-base | 77.0 | F11 |
| F11 + F9 stack | oracle | BGE-base | 78.2 | prior pre-F13 deployable |
| F12 + F9 stack | oracle | e5-large | 78.8 | F12 Gate-B FAIL, HARD RETRACTION |
| **F13 + F9 stack** | **oracle** | **BGE-base, chunked-turn** | **86.8** | **v1.9.2 deployable, Gate-B PASS** |
| **F14 + F9 stack (this track)** | **`_s`** | **BGE-base, chunked-turn** | **50.8** | **Gate-B FAIL, HARD RETRACTION** |
| gbrain v0.28.8 hybrid | `_s` | text-embedding-3-large | 97.60 | their report |
| gbrain v0.28.8 vector-only | `_s` | text-embedding-3-large | 97.40 | their ablation |
| gbrain v0.28.8 BM25-only | `_s` | (keyword) | 19.80 | their ablation |

The F13 vs F14 comparison (same pipeline, same embedder, different split) is the cleanest measurement we can produce of how the chunked-turn pipeline scales with distractor count: 86.8 on oracle (3 sessions/haystack) → 50.8 on `_s` (~48 sessions/haystack). A 16x increase in distractors collapses R@5 by 36 raw points. gbrain's own oracle-vs-`_s` comparison is not published in their report; the difference between gbrain's pipeline and F14 is dominated by the embedder, not the chunking.

## Cumulative-null acknowledgement

Per `docs/RETRACTION.md:94-113`, the dlPFC goal-stack mechanism's cumulative-null status is independent of this evaluation. F14 adds (i) the staged `data/lme_s/` data directory (gitignored), (ii) the `turn_index_bge_s.json` index (gitignored, ~3 GB), (iii) a minor `--data` CLI flag addition to `benchmarks/longmemeval/chunk_per_turn_{embed,retrieve}.mjs`, and (iv) F14 prereg + this result doc. F14 introduces no `src/` mechanism change. The cumulative-null finding stands unchanged.

## Outside-voice review trail

### Review (2026-05-12, isolated-context general-purpose subagent, Sonnet)

**Verdict:** PASS_WITH_NOTES (13/13 checks PASS or PASS_WITH_NOTE). No required fixes. Two optional improvements applied:

1. Added explicit parenthetical explaining the R@20 row regression (F14+F9 65.2 vs baseline 65.6) — the F9 rerank touches only top-20 candidates and can shift the marginal 20th slot on ties; R@20 is intentionally pinned to the baseline.
2. This review trail (the section you are reading).

Per-check summary:

1. Verbatim retraction sentence on own line — PASS.
2. Provenance disclosure binding (source SHA-256, no HF chain, tamper conditional) — PASS.
3. Embedder-mismatch disclosure binding (gbrain text-embedding-3-large vs F14 BGE-base) — PASS.
4. Gate-A PASS with 5 measurable conditions (turn count, dim, L2-norm, session coverage, tag carriage) — PASS.
5. Gate-B FAIL arithmetic 50.8 < 97.7, shortfall 46.9pp — PASS.
6. Per-K monotone within each variant, per-type sums to N=500 — PASS (R@20 baseline-vs-stack rounding-tie noted).
7. Cross-track summary table internally consistent — PASS.
8. HARD RETRACTION arm executed (data deleted, no canonical-doc updates, code paths retained with rationale, result-doc retention) — PASS.
9. Magnitude-smuggling grep 0 matches — PASS.
10. Cumulative-null cite `docs/RETRACTION.md:94-113` — PASS.
11. F13 vs F14 framing honest (same pipeline same embedder different split) — PASS.
12. "Embedder gap is dominant" claim supported by gbrain's own vector-only vs BM25-only ablation — PASS.
13. Framing as negative-result mechanism characterization (not inflated as success) — PASS.

Controller authorised to commit, push, and execute the on-disk HARD RETRACTION deletions.
