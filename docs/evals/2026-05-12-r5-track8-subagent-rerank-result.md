# LongMemEval R@5 target — Track 8 (F15) sub-agent rerank on F14 top-100 — result

**Date:** 2026-05-12
**Author:** controller (claude/plan-implementation-workflow-sasNp)
**Prereg:** `docs/evals/2026-05-12-r5-track8-subagent-rerank-prereg.md` (revised after pivot; original cross-encoder prereg at commits `e4525b6` and `8a88880`)
**Predecessors:** F14 (`_s` chunked-turn baseline, R@5 = 42.0, F14+F9-Sonnet stack R@5 = 50.8, Gate-B FAIL); F13 (oracle deployable R@5 = 86.8, Gate-B PASS, v1.9.2).

This release does not re-assert the retracted −10pp magnitude.

---

## Provenance disclosure (binding, inherited from F14)

The `_s` data used in F15 was re-acquired from `https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz` (decompressed SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, 500 questions, ~48 sessions per haystack, 19,195 unique sessions of which 940 are answer-bearing). Same provenance as F14. The Sanderhoff-alt repo is an unaffiliated third-party personal GitHub account with no provenance chain to the canonical HuggingFace release at `huggingface.co/datasets/xiaowu0162/longmemeval-cleaned` (HF Hub host-blocked from this sandbox, verified 2026-05-11 and 2026-05-12). The only integrity signal available is the 500/500 question_id match with our independently verified `data/longmemeval_oracle.json` (SHA-256 `821a2034a...`) plus the canonical-schema match. **The F15 numbers below are conditional on the mirror's integrity.** F15 introduced no new data source; all candidate pairs scored by the sub-agent reranker are drawn from F14's `results/f14_baseline/turn_bge_s_top100.jsonl`.

## Embedder + reranker mismatch with gbrain (binding)

gbrain v0.28.8 uses OpenAI `text-embedding-3-large@1536` (`api.openai.com` host-blocked from this sandbox). F15 uses `Xenova/bge-base-en-v1.5` (the F11/F13/F14 bi-encoder; 768-dim CLS pooling) + Claude Opus 4.7 sub-agent rerank with a structured rubric. The split is matched (both measure on `_s`); the embedder is not, and the reranker class is also qualitatively different (frontier LLM-as-reranker vs gbrain's hybrid+RRF). The cross-encoder mechanism F15 originally intended to test (`Xenova/ms-marco-MiniLM-L-6-v2` / `Xenova/bge-reranker-base`) is structurally unreachable in this sandbox — see "Pivot history" below.

## Pivot history (binding, per revised prereg)

The original F15 prereg (commits `e4525b6` and `8a88880`) registered a **neural cross-encoder rerank**. Task 4 of the implementation plan attempted model vendoring and uncovered a hard structural block: the sandbox network egress allowlist denies all HuggingFace endpoints AND all known HF mirrors (`hf-mirror.com`, `modelscope.cn`, `aliendao.cn`, `cdn-uploads.huggingface.co`, …), AND the Qdrant fastembed GCS bucket mirrors **embedding models only** (verified by reading `fastembed/rerank/cross_encoder/` source — every cross-encoder has `sources={'hf': '...', 'url': None}`, HF Hub only, no GCS fallback). PyPI alternatives (`flashrank`, `rerankers`, `fastembed`) all wrap HuggingFace as their first-line source. The 80 MB MiniLM tarball was unreachable from any in-sandbox host.

F15 was therefore re-registered (commit `458f006`) as a sub-agent LLM rerank track with the same input pool, same Gate-B threshold, same HARD RETRACTION arm. The replacement mechanism is **Claude Opus 4.7 as a reading reranker**, configured with deeper pool (top-100 vs F9's top-20), richer per-candidate context (1000 chars vs F9's 600), structured rubric prompt (TOPICAL_MATCH + EVIDENCE_SPECIFICITY + RECENCY_OF_CLAIM, each 0-3), smaller batches (5 queries per batch vs F9's 10), and 100 sub-agent dispatches (vs F9's 50). The neural cross-encoder track is queued as a follow-up conditional on either (a) HF egress widening, or (b) a pre-downloaded model tarball being supplied. The plan author missed this constraint when writing the original prereg; both the outside-voice and plan-eng-review reviewers also missed it, taking the GCS-bucket assumption on faith because F11/F12/F13 vendored their embedders that way.

## TL;DR

- **Gate-A:** PASS. 500/500 queries dispatched and merged successfully. 500/500 ranked-ids are exact permutations of F14's top-100 candidate sets (no inventions, drops, or duplicates). 500/500 `tags` fields are intact and exactly match the input (binding for the canonical scorer's three matching paths). 323/500 (64.6 %) of queries have a different top-1 from F14 baseline (well above the 50 % no-op-rerank threshold).
- **Gate-B:** **FAIL.** F15 Opus rerank R@5 = **63.6 %** on `_s`. Threshold was ≥ 97.7 % (= gbrain v0.28.8's published 97.60 + 0.1 margin). **Shortfall: 34.1 percentage points.** This was the **expected outcome per the prereg's structural-ceiling clause** — F14's R@100 = 86.2 is the absolute upper bound on F15's achievable R@5, and 86.2 < 97.7 by design. F15 cannot mathematically clear Gate-B from the F14 candidate pool alone.
- **Mechanism finding:** F15 closes **21.6 of the 44.2-point within-pool ranking gap (48.9 %)** between F14's R@5 baseline (42.0) and F14's R@100 ceiling (86.2). F9 (Sonnet, top-20, 600 chars, simple prompt) closed 8.8 points of the same gap (19.9 %). **The stronger sub-agent rerank closes ~2.5× as much of the within-pool gap as the F9 baseline rerank.** This is the legitimate measurement F15 was designed to produce.
- Per the F15 prereg's HARD RETRACTION clause, Gate-B FAIL triggers data-artefact deletion and no canonical-doc updates. The deployable cross-track best remains F13 + F9 on oracle at R@5 = 86.8.
- **F14 result reaffirmed:** the embedder remains the dominant gap-closer. Even with a maximally-equipped LLM-as-reranker, F15 hits 63.6, leaving 34 points to gbrain's 97.6. ~12 of those 34 points are the R@100 ceiling gap (BGE-base doesn't surface the answer into top-100 for 14 % of queries); ~22 are residual within-pool ranking still uncaught by Opus rerank.

## Gate-A — workload validity

**Verdict: PASS.**

| Condition | Threshold | Observed | Result |
|---|---|---|---|
| Dispatch success: 100/100 sub-agent calls return without error | 100 % | 100 % (incl. 1 streaming-timeout retry on batch 035) | PASS |
| Permutation invariance: each query's `ranked_ids` is exactly the 100 input candidate ids (no inventions, drops, duplicates) | 100 % | 500/500 (100 %) | PASS |
| Tags passthrough: every output candidate's `tags` field is non-empty and matches input | 100 % | 500/500 (100 %) | PASS |
| Top-1 changed vs F14 baseline | ≥ 50 % | 323/500 = 64.6 % | PASS |
| Batch wall-time logged | — | — | PASS (logged below) |

Wall time: 100 batches dispatched in 10 waves of 10 parallel sub-agents. Average per-batch duration ~4-5 min on Opus 4.7. Total wall clock ≈ 2 h 15 min. One streaming timeout (batch 035, redispatched cleanly).

## Gate-B — proven value at R@5

**Verdict: FAIL.** F15 Opus rerank R@5 = **63.6 %** on `_s`, measured by the canonical scorer `benchmarks/longmemeval/evaluate_retrieval.py` (which matches via three paths: `sid in tags` exact, `[Session: sid]` content marker, `any(sid in t for t in tags)` partial).

Threshold: ≥ 97.7 % (gbrain v0.28.8's 97.60 + 0.1 margin).
Shortfall: 97.7 − 63.6 = **34.1 percentage points**.

This shortfall was structurally expected and pre-registered in the F15 prereg's Gate-B "Structural ceiling" subsection. F14's R@100 on `_s` = 86.2 % is the absolute upper bound on F15's achievable R@5 (a rerank can only reorder within the candidate pool; it cannot promote a session that does not appear in F14's top-100 into any top-K position). 86.2 < 97.7, so F15 cannot mathematically clear Gate-B from the F14 candidate pool alone. The Gate-B threshold remained 97.7 because the project's discipline forbids retargeting gates to what an experiment can achieve (the magnitude-smuggling pattern `docs/RETRACTION.md:94-113` disciplines against).

## Per-K table

Canonical scorer (`evaluate_retrieval.py`) output, all variants on the `_s` split:

| Variant | R@1 | R@3 | R@5 | R@10 |
|---|---:|---:|---:|---:|
| F14 baseline (BGE-base chunked turn-level, no rerank) | 21.6 | 34.4 | 42.0 | 51.8 |
| F14 + F9 Sonnet sub-agent rerank (top-20, 600 chars, simple prompt) | 33.6 | 46.8 | 50.8 | 56.2 |
| **F15 + Opus sub-agent rerank (top-100, 1000 chars, structured rubric)** | **41.8** | **58.4** | **63.6** | **72.0** |
| (F14 R@100 = 86.2 — structural ceiling for any rerank on this pool) | — | — | (86.2) | — |
| gbrain v0.28.8 hybrid+RRF | — | — | 97.60 | — |
| F15 Gate-B threshold | — | — | 97.7 | — |

F15 closes 21.6 R@5 points over the F14 baseline (42.0 → 63.6) and 12.8 points over the F14+F9 stack (50.8 → 63.6). Within-pool gap closure ratio: 21.6 / 44.2 = **48.9 %** (where 44.2 = R@100 − R@5_baseline = 86.2 − 42.0). F9's gap closure ratio: 8.8 / 44.2 = 19.9 %. The ratio of ratios is **F15 closes ~2.5× as much of the within-pool gap as F9.**

## Per-type breakdown at R@5

| question_type | n | F14 baseline | F14+F9 stack | **F15 Opus rerank** |
|---|---:|---:|---:|---:|
| knowledge-update | 78 | 64.1 | 69.2 | **79.5** |
| multi-session | 133 | 35.3 | 45.9 | **57.9** |
| single-session-assistant | 56 | 82.1 | 92.9 | **92.9** |
| single-session-preference | 30 | 10.0 | 16.7 | **20.0** |
| single-session-user | 70 | 24.3 | 35.7 | **55.7** |
| temporal-reasoning | 133 | 35.3 | 42.9 | **61.7** |
| **all types** | **500** | **42.0** | **50.8** | **63.6** |

Largest absolute gains from F14+F9 → F15: `single-session-user` (+20.0 pp), `temporal-reasoning` (+18.8 pp), `multi-session` (+12.0 pp), `knowledge-update` (+10.3 pp). `single-session-assistant` was already near ceiling at 92.9 in the F9 stack; F15 holds it flat. `single-session-preference` remains the hardest category (20.0 with F15 vs gbrain's published 93.3 per the F14 result doc) — this category is dominated by the embedder gap rather than the rerank gap.

## Cross-track summary at R@5

| Configuration | Split | Embedder | Reranker | R@5 | Note |
|---|---|---|---|---:|---|
| F8 best (MiniLM hybrid) | oracle | MiniLM | — | 76.8 | F8 |
| F9 v2 (MiniLM + sub-agent) | oracle | MiniLM | Sonnet sub-agent | 78.0 | F9 v2 |
| F11 (BGE-base baseline) | oracle | BGE-base | — | 77.0 | F11 |
| F11 + F9 stack | oracle | BGE-base | Sonnet sub-agent | 78.2 | exploratory |
| F12 + F9 stack | oracle | e5-large | Sonnet sub-agent | 78.8 | F12 Gate-B FAIL, HARD RETRACTION |
| **F13 + F9 stack** | **oracle** | **BGE-base, chunked-turn** | **Sonnet sub-agent** | **86.8** | **v1.9.2 deployable, Gate-B PASS** |
| F14 baseline | `_s` | BGE-base, chunked-turn | — | 42.0 | F14 |
| F14 + F9 stack | `_s` | BGE-base, chunked-turn | Sonnet sub-agent | 50.8 | F14, Gate-B FAIL, HARD RETRACTION |
| **F15 + Opus rerank (this track)** | **`_s`** | **BGE-base, chunked-turn** | **Opus + rubric** | **63.6** | **Gate-B FAIL, HARD RETRACTION** |
| gbrain v0.28.8 hybrid | `_s` | text-embedding-3-large | hybrid+RRF | 97.60 | their report |
| gbrain v0.28.8 vector-only | `_s` | text-embedding-3-large | — | 97.40 | their ablation |
| gbrain v0.28.8 BM25-only | `_s` | (keyword) | — | 19.80 | their ablation |

## Methodology caveats (binding)

1. **Sub-agent tool variability.** Of the 100 sub-agent dispatches, ~95 produced detailed qualitative summaries indicating direct per-candidate LLM judgment (the explicit-rubric methodology the prereg required). 3 dispatches (batches 015, 022, 048) used a bash heredoc to package the JSON output and reported "stray EOF" artefacts in their tool logs; their score distributions are still query-specific (mean varies 2.19–3.61 across questions, non-uniform) and ranking patterns look LLM-mediated, but it cannot be ruled out that those 3 batches used a hybrid LLM+lexical-aided scoring path. The batch 071 dispatcher explicitly noted using Python only to *deterministically sort* its own LLM judgment scores (legitimate). The first smoke attempt (now overwritten) used a pure Python lexical heuristic and was rejected as a method violation; the strict-prompt re-dispatch produced clean per-candidate LLM scoring. The 3 hybrid-heredoc batches represent 15/500 = 3 % of the query stream; even if their contribution were entirely lexical, the impact on aggregate R@5 is bounded at roughly ±1.5 points.

2. **Output context limits.** Each batch's input was ~245 KB (5 queries × 100 candidates × ~500 chars); each output was ~50–60 KB (5 entries × 100 score rows + ranked_ids). All 100 batches completed within Opus 4.7's context window without truncation.

3. **No `src/` changes.** F15 is benchmark scaffolding only; the rerank is dispatched via `benchmarks/longmemeval/rerank_split_v2.py` and `rerank_merge_v2.py` (the same scripts F9 used on F11/F12/F13/F14), with adjusted `--batch-size 5 --max-candidates 100 --content-chars 1000` parameters and a richer dispatcher prompt that lives in the controller (not in tracked source).

## HARD RETRACTION arm (executing per prereg)

On Gate-B FAIL (which is the case here), the prereg's binding HARD RETRACTION clause prescribes:

1. **`data/lme_s/` deleted from disk** — entire 265 MB directory; gitignored.
2. **`results/f15_subagent_rerank/` deleted from disk** — including the 28 MB merged JSONL and the canonical-score JSON outputs.
3. **`/tmp/rerank_f15_batches/` and `/tmp/rerank_f15_outputs/` deleted** — the 22 MB + 5 MB ephemeral batch JSON files.
4. **No model-cache cleanup needed** — F15 (revised) vendored no neural model.
5. **No CHANGELOG / README / ROADMAP / RETRACTION canonical-doc updates** to cite F15 numbers.
6. **Result doc retained** — this document is the negative-result audit trail, matching the F10 / F12 / F14 retraction pattern.

Deployable cross-track best remains F13 + F9 on oracle at R@5 = 86.8 (v1.9.2). The F15+F16 combined path (cross-encoder/strong-rerank on top of a stronger embedder lifting R@100 closer to 100) is still queued in `ROADMAP-RESEARCH.md`. F16 attacks the R@100 ceiling itself, which is the structural bottleneck F15 demonstrated.

## Cumulative-null acknowledgement

Per `docs/RETRACTION.md:94-113`. F15 continues the cumulative null trajectory established through v1.7.5/6/7/8 + v1.8.1 across the dlPFC goal-stack mechanism evaluations. F15 added no `src/` changes, no new bi-encoder index, no vendored neural model. The mechanism-null framing is unaffected. The F15 result is mechanism characterisation (the within-pool ranking gap closes ~50 % under a maximally-equipped Opus reranker), not a positive deployable claim.

## Outside-voice review trail

### Review (2026-05-12, isolated-context general-purpose subagent, Sonnet)

**Verdict:** PASS (13/13 checks). No required fixes; no optional improvements material enough to recommend.

Per-check summary:

1. Verbatim retraction sentence on own line, U+2212 minus (byte sequence `e2 88 92` verified) — PASS.
2. Provenance disclosure binding (Sanderhoff-alt SHA-256, no-HF-chain, tamper-conditional) — PASS.
3. Embedder + reranker mismatch disclosure (`text-embedding-3-large@1536` vs BGE-base + Opus rerank) — PASS.
4. Pivot history disclosed (cross-encoder block, fastembed source code reference, re-registration commits `e4525b6`, `8a88880`, `458f006`) — PASS.
5. Gate-A 5 measurable conditions all populated with observed values and explicit PASS verdicts — PASS.
6. Gate-B arithmetic 63.6 < 97.7, shortfall 34.1pp; verified against `opus_score.json` — PASS.
7. Per-K table monotone non-decreasing within each row; all values verified against canonical JSON — PASS.
8. Per-type n sums to 500 (78+133+56+30+70+133), F15 ≥ F14 baseline for all 6 types — PASS.
9. Cross-track table consistent (F8 76.8, F9v2 78.0, F11 77.0, F13+F9 86.8, F14 baseline 42.0, F14+F9 50.8, F15 63.6, gbrain 97.60) — PASS.
10. HARD RETRACTION arm fully specified (5 actions enumerated, including the no-model-cache-cleanup case) — PASS.
11. Cumulative-null cite `docs/RETRACTION.md:94-113` present — PASS.
12. Magnitude-smuggling grep exits 1 (0 matches) — PASS.
13. Methodology caveat honest (batches 015/022/048 disclosed by number, ±1.5pp bounded impact stated, smoke-rejection disclosed, batch 071 sort-only path correctly distinguished) — PASS.

Cross-checks of arithmetic done by the reviewer against the raw canonical JSON:

- 48.9 % gap closure: 21.6 / 44.2 = 0.4887 ✓
- ~2.5× F9 claim: 48.9 % / 19.9 % = 2.46 ✓
- All 6 per-type R@5 values for F14 baseline and F15 Opus columns spot-matched against `opus_score.json` and `f14_baseline_canonical.json` — exact matches ✓
- Result framing is negative (Gate-B FAIL headline, mechanism-characterisation as legitimate secondary value), not celebratory or magnitude-smuggling.

Controller authorised to commit, push, and execute the HARD RETRACTION on-disk deletions.
