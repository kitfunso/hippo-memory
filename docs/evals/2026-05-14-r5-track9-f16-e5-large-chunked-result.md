# LongMemEval R@5 target — Track 9 (F16) multilingual-e5-large chunked-turn on `_s` — result

**Date:** 2026-05-19
**Author:** controller (claude/plan-implementation-workflow-sasNp)
**Prereg:** `docs/evals/2026-05-14-r5-track9-f16-e5-large-chunked-prereg.md`
**Predecessors:** F14 baseline (BGE-base chunked-turn `_s`, R@5 = 42.0, R@100 = 86.2, Gate-B FAIL, HARD RETRACTION); F15 Opus rerank on F14's top-100 (R@5 = 63.6, Gate-B FAIL, HARD RETRACTION); F12 multilingual-e5-large session-level oracle (R@5 = 78.8 with F9 stack, +0.6-point delta over BGE-base session-level, Gate-B FAIL, HARD RETRACTION); F13 BGE-base chunked-turn oracle (R@5 = 86.8 with F9 stack, Gate-B PASS, v1.9.2 deployable).

This release does not re-assert the retracted −10pp magnitude.

---

## Provenance disclosure (binding, inherited from F14/F15)

The `_s` data used in F16 was re-acquired from `https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz` (decompressed SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` — verified identical to F14/F15 on re-acquisition 2026-05-15). The Sanderhoff-alt repo is an unaffiliated third-party personal GitHub account with no documented provenance link to the LongMemEval authors or the canonical HF release. The only integrity signal is the 500/500 question_id match with the independently verified `data/longmemeval_oracle.json` plus the canonical-schema match — same posture as F14 and F15. **The F16 numbers below are conditional on the mirror's integrity.** F16 introduced no new data source.

## Embedder mismatch with gbrain (binding)

gbrain v0.28.8 uses OpenAI `text-embedding-3-large@1536` (`api.openai.com` host-blocked from this sandbox). F16 uses `Xenova/multilingual-e5-large` (335M params, 1024-dim, mean pooling, e5 "query: " / "passage: " prefix convention; weights present on disk from F12's HARD RETRACTION carve-out, loaded via the `@huggingface/transformers` v4 fork — `@xenova/transformers` v2.17 cannot load this model's ONNX external-data format). gbrain's published vector-only ablation scored 97.40 % R@5 on `_s`; the embedder is the dominant factor in gbrain's headline. **F16 measures multilingual-e5-large chunked-turn baseline on `_s`; gbrain measures text-embedding-3-large + sessions-as-chunks + RRF on `_s`. The split is matched; the embedder is not.** F16 is a strict 1-axis swap from F14 (only the bi-encoder model changes); no LLM-reranker stage.

## Pre-flight finding (binding)

F16's scope was bounded by a 2026-05-14 pre-flight that enumerated fastembed's text-embedding catalog: only six models are GCS-reachable from this sandbox (HF Hub blocked, all known HF mirrors blocked, all PyPI alternatives wrap HF as first-line source). Of those six, only `intfloat/multilingual-e5-large` (1024-dim) is structurally stronger than the F14 baseline `BAAI/bge-base-en-v1.5` (768-dim). `bge-large-en-v1.5`, `mxbai-embed-large-v1`, `e5-large-v2`, `gte-large` are all HF-only. F16 is therefore the only locally-runnable embedder-swap track available for `_s`, and a single-configuration track, not a sweep. The constraint is a sandbox-reachability artefact, not a considered-and-rejected ablation space.

## TL;DR

- **Gate-A:** PASS — all five conditions. 199,509 turn vectors indexed at dim 1024, L2-norms 1.0; 19,195 sessions covered; 500/500 queries retrieved with 100 candidates each; 500/500 `tags` fields populated; 373/500 (74.6 %) of top-1 session_ids differ from the F14 BGE-base baseline.
- **Gate-B:** **FAIL.** F16 baseline R@5 = **43.6 %** on `_s`. Threshold was ≥ 97.7 % (gbrain v0.28.8's 97.60 + 0.1 margin). **Shortfall: 54.1 percentage points.** This was the **expected outcome per the prereg's structural-ceiling clause.**
- **Primary mechanism finding — the embedder swap is essentially inert.** F16 baseline R@5 = 43.6 vs F14 baseline R@5 = 42.0: a +1.6-point delta, within noise. F12 measured the same embedder at session-level on oracle and saw a +0.6-point delta. The chunking lever (F13's contribution) did **not** amplify the embedder swap — the delta stays in the flat band (+0.6 to +1.6) regardless of split or granularity.
- **Secondary mechanism finding — the candidate-pool ceiling did NOT lift; it dropped.** F16 baseline R@100 = **84.8 %** vs F14 baseline R@100 = 86.2 %: a −1.4-point delta. The prereg's secondary question — "does F16 R@100 lift above F14's 86.2 by ≥ 3 points?" — gets a definitive **NO**. The F14 R@100 ceiling is **not a BGE-base-specific artefact**: it is structural to locally-runnable bi-encoders on this workload. multilingual-e5-large, at 3× the parameter count and 1024 vs 768 dimensions, surfaces the answer-bearing session into the top-100 at the *same* rate (slightly lower, within noise). **The locally-runnable embedder lever is exhausted.**
- Per the F16 prereg's HARD RETRACTION clause, Gate-B FAIL triggers data-artefact deletion and no canonical-doc updates. The deployable cross-track best remains F13 + F9 on oracle at R@5 = 86.8.

## Gate-A — workload validity

**Verdict: PASS.**

| Condition | Threshold | Observed | Result |
|---|---|---|---|
| Model load from local cache (no silent HF fallback) | loads, dim 1024, norm 1.0 | Step-1 preflight: `dim=1024 norm=1.000000`; weights from `model-cache/Xenova/multilingual-e5-large/` | PASS |
| Index shape: 199,509 ± 100 turn vectors, dim 1024, L2-norms in [0.9999, 1.0001] | within tolerance | 199,509 turn records (exact match to F14 BGE-base count), 19,195 sessions, dim 1024, 50/50 sampled norms = 1.00000 | PASS |
| Retrieval completeness: all 500 queries, 100 candidates each | 500/500 | 500/500 with exactly 100 candidates | PASS |
| Tags passthrough: every candidate's `tags` non-empty | 500/500 | 500/500 | PASS |
| Top-1 differs from F14 BGE-base baseline | ≥ 30 % | 373/500 = 74.6 % | PASS |

Build wall time: the chunked-turn index build took ~28 h of cumulative CPU compute (199,509 turns at ~2–3 turns/s on the 4-core CPU, multilingual-e5-large), spread across several VM-suspension/resume cycles; the embed script's lossless JSONL-partial resume handled every interruption. Retrieval wall time: 286.9 s for all 500 queries.

## Gate-B — proven value at R@5

**Verdict: FAIL.** F16 baseline R@5 = **43.6 %** on `_s`, measured by the canonical scorer `benchmarks/longmemeval/evaluate_retrieval.py` (matches via three paths: `sid in tags` exact, `[Session: sid]` content marker, `any(sid in t for t in tags)` partial).

Threshold: ≥ 97.7 %. Shortfall: 97.7 − 43.6 = **54.1 percentage points**.

This shortfall was structurally expected and pre-registered in the F16 prereg's "Structural ceiling" subsection. A 1-axis embedder swap cannot clear Gate-B unless it lifts R@100 to ≥ 97.7 in the baseline (the post-retrieval R@5 is bounded above by R@100). F16's R@100 came in at 84.8 — below F14's 86.2 — so Gate-B was unreachable, exactly as the prereg's downside case described. The Gate-B threshold remained 97.7 because the project's discipline forbids retargeting gates to what an experiment can achieve.

## Per-K table

Canonical scorer output, `_s` split, all variants:

| Variant | R@1 | R@3 | R@5 | R@10 | R@20 | R@100 |
|---|---:|---:|---:|---:|---:|---:|
| F14 baseline (BGE-base chunked-turn, no rerank) | 21.6 | 34.4 | 42.0 | 51.8 | 65.6 | 86.2 |
| F14 + F9 Sonnet sub-agent rerank | 33.6 | 46.8 | 50.8 | 56.2 | — | (86.2) |
| F15 + Opus sub-agent rerank (top-100, rubric) | 41.8 | 58.4 | 63.6 | 72.0 | — | (86.2) |
| **F16 baseline (e5-large chunked-turn, no rerank)** | **21.0** | **35.8** | **43.6** | **52.4** | **62.2** | **84.8** |
| gbrain v0.28.8 hybrid+RRF | — | — | 97.60 | — | — | — |
| F16 Gate-B threshold | — | — | 97.7 | — | — | — |

F16 vs F14 baseline (the controlled 1-axis comparison): R@5 +1.6, R@1 −0.6, R@10 +0.6, R@20 −3.4, R@100 −1.4. Every K-level delta is within ±3.4 points — there is no level at which the e5-large swap produces a material, consistent improvement over BGE-base. The F15 + Opus rerank row (63.6) remains the cross-track best on `_s`; F16's embedder swap does not approach it, confirming that within-pool re-ranking (F15) is a larger lever than the locally-available embedder swap (F16).

## Per-type breakdown at R@5

| question_type | n | F14 baseline | **F16 baseline** | delta |
|---|---:|---:|---:|---:|
| knowledge-update | 78 | 64.1 | **62.8** | −1.3 |
| multi-session | 133 | 35.3 | **34.6** | −0.7 |
| single-session-assistant | 56 | 82.1 | **92.9** | +10.8 |
| single-session-preference | 30 | 10.0 | **3.3** | −6.7 |
| single-session-user | 70 | 24.3 | **27.1** | +2.8 |
| temporal-reasoning | 133 | 35.3 | **38.3** | +3.0 |
| **all types** | **500** | **42.0** | **43.6** | **+1.6** |

The per-type picture is noise, not signal: three types up, three down, no coherent pattern, and the two largest moves point in opposite directions (`single-session-assistant` +10.8, `single-session-preference` −6.7). `single-session-preference` — already the hardest category for every F-track variant — collapses to 3.3 with e5-large; this category is dominated by the embedder gap and neither locally-available embedder handles it. The `single-session-assistant` gain is the one bright spot but it does not generalise. The aggregate +1.6 is the honest summary: the swap is inert.

## Cross-track summary at R@5

| Configuration | Split | Embedder | Reranker | R@5 | Note |
|---|---|---|---|---:|---|
| F13 + F9 stack | oracle | BGE-base chunked-turn | Sonnet sub-agent | 86.8 | v1.9.2 deployable, Gate-B PASS |
| F14 baseline | `_s` | BGE-base chunked-turn | — | 42.0 | Gate-B FAIL, HARD RETRACTION |
| F14 + F9 stack | `_s` | BGE-base chunked-turn | Sonnet sub-agent | 50.8 | Gate-B FAIL, HARD RETRACTION |
| F15 + Opus rerank | `_s` | BGE-base chunked-turn | Opus + rubric | 63.6 | Gate-B FAIL, HARD RETRACTION |
| **F16 baseline (this track)** | **`_s`** | **multilingual-e5-large chunked-turn** | **—** | **43.6** | **Gate-B FAIL, HARD RETRACTION** |
| gbrain v0.28.8 vector-only | `_s` | text-embedding-3-large | — | 97.40 | their ablation |
| gbrain v0.28.8 hybrid | `_s` | text-embedding-3-large | hybrid+RRF | 97.60 | their report |

## What F16 settles

F16 was designed to answer one question: does the strongest locally-runnable embedder, applied at chunked-turn granularity, materially lift retrieval on `_s`? The answer is **no, and decisively so**:

1. **The embedder swap is inert at every K.** BGE-base (768-dim, 110M params) → multilingual-e5-large (1024-dim, 335M params) moves R@5 by +1.6 and R@100 by −1.4. Both are within run-to-run noise. F12's session-level oracle measurement (+0.6) and F16's chunked-turn `_s` measurement (+1.6) bracket the same flat band; the chunking lever does not amplify the embedder.
2. **The R@100 ceiling is embedder-class-structural, not BGE-base-specific.** This is the most important finding. F14/F15 left open the possibility that R@100 = 86.2 was a weakness of BGE-base specifically. F16 closes that: a 3×-larger, higher-dimensional bi-encoder lands at R@100 = 84.8 — statistically the same ceiling. For ~14–15 % of `_s` queries the answer-bearing session is not in the top-100 for *either* locally-runnable embedder. No rerank can recover those (F15 already demonstrated rerank is pool-bounded).
3. **The locally-runnable embedder lever is exhausted.** With both GCS-reachable embedder options measured and flat, the path to gbrain's 97.6 genuinely requires a qualitatively different embedder — `text-embedding-3-large` (needs `api.openai.com` egress; queued as F17) or a model behind HF egress (F18-class). This is now an evidence-backed conclusion, not a conjecture. (Caveat on confidence: the supporting evidence is n=2 — F12 and F16 — and those two points differ on two axes at once, split and granularity, which the prereg flagged as "not strictly apples-to-apples." The direction and magnitude are consistent across both, so the conclusion is well-supported as a *direction*; it is not a tight quantitative bound. An English-specialised same-size bi-encoder remains formally untested per caveat 1 below.)

The legitimate value F16 delivers is this negative result: it converts "the embedder is probably the bottleneck" (F14/F15's inference) into "the locally-runnable embedder lever is measured, flat, and exhausted" (F16's measurement). That is the experiment working as designed.

## Methodology caveats (binding)

1. **multilingual-e5-large is a multilingual model.** LongMemEval `_s` is English-only. A multilingual model spreads representational capacity across languages; an English-specialised model of the same size could plausibly score marginally higher. The −1.4-point R@100 delta vs English-specialised BGE-base is consistent with (but not proof of) this. This does not change the conclusion — the swap is flat — but it means "stronger embedder" should be read as "stronger *and multilingual*"; an English-specialised `bge-large-en-v1.5` (HF-only, unreachable) remains formally untested.
2. **ONNX external-data dispatch.** multilingual-e5-large ships ONNX weights in the external-data format (`model.onnx` + `model.onnx_data`, 2.2 GB). Loading requires `@huggingface/transformers` v4; the legacy `@xenova/transformers` v2.17 cannot load it. The F12 dispatch helper handled this. Pooling is mean (e5 convention) and the "query: " / "passage: " prefixes are applied by `chunk_per_turn_embed.mjs` / `chunk_per_turn_retrieve.mjs` automatically by model-name regex.
3. **Build interruptions.** The 28-h index build spanned multiple VM suspend/resume cycles. The embed script resumes losslessly from a `.partial.jsonl` checkpoint keyed on (session_id, turn_idx); the final index has exactly 199,509 turn records — the same count as F14's BGE-base index — confirming no turns were dropped or double-counted across resumes.
4. **No `src/` changes.** F16 is benchmark scaffolding only. It reuses `chunk_per_turn_embed.mjs` + `chunk_per_turn_retrieve.mjs` (already parameterised for both bge and e5 model families) with no modification.

## HARD RETRACTION arm (executing per prereg)

On Gate-B FAIL (the case here), the prereg's binding HARD RETRACTION clause prescribes:

1. **`data/lme_s/` deleted** — 265 MB; gitignored.
2. **`results/f16_e5_large/` deleted** — retrieval JSONL (31 MB) + score JSON outputs.
3. **`benchmarks/longmemeval/data/turn_index_e5_s.json.jsonl` deleted** — the 4.3 GB F16 chunked-turn index; plus `turn_index_e5_s.json.partial.jsonl` if present.
4. **`/tmp/f16_build.log` and `/tmp/f16_retrieve.log` deleted.**
5. **`benchmarks/longmemeval/data/model-cache/Xenova/multilingual-e5-large/` is RETAINED** — these weights pre-date F16 (vendored by F12, preserved by F12's HARD RETRACTION carve-out); F16 did not download them.
6. **No CHANGELOG / README / ROADMAP / RETRACTION canonical-doc updates** citing F16 numbers.

The F16 result doc is retained as a negative-result audit trail.

Deployable cross-track best remains F13 + F9 on oracle at R@5 = 86.8 (v1.9.2). The path to clearing Gate-B on `_s` is now evidence-backed: it requires `text-embedding-3-large` (F17, blocked on `api.openai.com` egress) or an HF-egress-gated stronger embedder, plus — per F-track item F9 — local hybrid BM25+vector+graph RRF fusion, which no F-track measurement has yet attempted and which is the highest-value untried locally-runnable lever.

## Cumulative-null acknowledgement

Per `docs/RETRACTION.md:94-113`. F16 continues the cumulative null trajectory established through v1.7.5/6/7/8 + v1.8.1 across the dlPFC goal-stack mechanism evaluations. F16 added no `src/` changes, no vendored model (the e5-large weights pre-date F16), and no new bi-encoder beyond what F12 already vendored. The mechanism-null framing is unaffected. F16's result is mechanism characterisation — the locally-runnable embedder lever is measured and flat — not a positive deployable claim.

## Outside-voice review trail

### Review (2026-05-19, isolated-context general-purpose subagent, Sonnet)

**Verdict:** PASS_WITH_NOTES (13/13 checks PASS). No required fixes.

Per-check summary:

1. Verbatim retraction sentence on own line, U+2212 minus (byte sequence `e2 88 92` verified) — PASS.
2. Provenance disclosure binding (Sanderhoff-alt SHA-256 verbatim, no-HF-chain, tamper-conditional) — PASS.
3. Embedder mismatch disclosure (`text-embedding-3-large@1536` vs `multilingual-e5-large`) — PASS.
4. Pre-flight finding disclosed (1 GCS-reachable stronger embedder; single-configuration not a sweep) — PASS.
5. Gate-A 5 conditions populated with thresholds + observed values — PASS.
6. Gate-B arithmetic 43.6 < 97.7, shortfall 54.1pp; verified against `baseline_score.json` — PASS.
7. Per-K table monotone, F16 row matches the JSON exactly — PASS.
8. Per-type n sums to 500; all six per-type R@5 values and all six delta arithmetic verified — PASS.
9. Cross-track table consistent (F13+F9 86.8, F14 42.0, F14+F9 50.8, F15 63.6, F16 43.6, gbrain 97.40/97.60) — PASS.
10. HARD RETRACTION arm fully specified (6 actions incl. model-cache retention) — PASS.
11. Cumulative-null cite `docs/RETRACTION.md:94-113` present — PASS.
12. Magnitude-smuggling grep exits 1 (0 matches) — PASS.
13. Mechanism framing honest — Gate-B FAIL is the headline; +1.6 called "inert"/"within noise"; −1.4 R@100 framed as "did NOT lift; it dropped", not spun; multilingual caveat explicit — PASS.

Reviewer cross-checks: R@5 = 43.6 confirmed against `baseline_score.json`; `recall@100 = 84.8` confirmed present as a direct JSON field (extended-k re-score); all per-type and delta arithmetic verified.

Optional improvement applied: the reviewer noted point 3 of "What F16 settles" asserted lever-exhaustion with slightly more confidence than an n=2 evidence base (F12 + F16, differing on two axes) strictly warrants. A confidence caveat was added inline acknowledging the n=2 basis and that the conclusion is well-supported as a *direction* but not a tight quantitative bound.

Controller authorised to commit, push, and execute the HARD RETRACTION on-disk deletions.
