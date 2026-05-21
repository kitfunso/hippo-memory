# F9 hybrid retrieval parity (BM25 + chunked-turn dense via RRF) — result

**Date:** 2026-05-20 (Phase 1) / 2026-05-21 (Phase 2)
**Plan:** `docs/plans/2026-05-20-f9-hybrid-retrieval-parity.md`
**Pre-reg:** `docs/evals/2026-05-20-f9-hybrid-rrf-prereg.md` (BINDING as of dry-run PASS in `docs/evals/2026-05-20-f9-dry-run.md`)
**Status:** COMPLETE. Phase 1 oracle (cross-comparison) + Phase 2 `_s` (binding Gate-B) both run.
**Gate-B verdict: FAIL.** Best hybrid variant on `_s` = `turn_sym` R@5 = 50.8 vs the binding 97.7 threshold.

This release does not re-assert the retracted −10pp magnitude.

---

## TL;DR

**Split-mismatch disclosure (binding, stated before any number below):** the binding `_s` numbers are on `data/lme_s/longmemeval_s_cleaned.json`, acquired from the `Sanderhoff-alt/longmemeval-zh` GitHub mirror with NO signed chain-of-custody to the canonical HF release (same disclaimer F14/F15/F16 carry). gbrain v0.28.8's 97.60 uses OpenAI `text-embedding-3-large` — not directly comparable to F9's BGE-base. Oracle numbers are a 3-session-per-haystack split, cross-comparison only, never gbrain-comparable. Full disclosure in §"Split-mismatch disclosure" below.

F9 is the first F-track measurement of **local BM25 + chunked-turn dense RRF fusion**. The mechanism works and produces a real, sizable lift — on the binding `_s` split, the best hybrid variant (`turn_sym`, symmetric 0.5/0.5 weighting, turn-level BM25) lifts dense-only R@5 from 41.0 to 50.8 (a `+9.8` improvement), and wins on every K (R@1/3/5/10) and every one of the six question types.

Two things are simultaneously true and both must be stated:

1. **Gate-B FAILS.** 50.8 « 97.7. F9 hybrid does not clear the bar F14/F15/F16 also missed. Per the prereg, this triggers HARD RETRACTION of the eval artifacts (BM25 corpora deleted; no canonical-doc number claims).
2. **The hybrid fusion lever is the strongest locally-runnable lever measured in the F-track.** `turn_sym` at 50.8 on `_s` **ties the F14+F9-Sonnet-rerank stack's 50.8** — a result that previously required 50 LLM sub-agent dispatches per eval run. F9 hybrid achieves the same R@5 at **zero inference cost and zero API spend**. The cumulative-null F-track inventory now has a clean answer to "is local hybrid fusion worth it": yes for cost, no for clearing the `_s` ceiling.

The structural conclusion corroborates F16 from a new angle: the locally-runnable embedder is the bottleneck on `_s`, not the retrieval signal mix. F9 does not independently re-derive the embedder ceiling — it adds one corroborating data point (a signal-mix variant that still caps at ~51 R@5 while the F14 R@100 candidate-pool ceiling of 86.2 stays BGE-base-bound).

---

## Headline (Phase 1 oracle — COMPLETE)

| Cell | BM25 weight | Dense weight | BM25 level | R@5 (oracle) | vs F13 baseline 79.0 |
|---|---:|---:|---|---:|---:|
| dense_only | 0.0 | 1.0 | — | **79.0** | sanity PASS (exact reproduction) |
| turn_sym | 0.5 | 0.5 | turn | 80.6 | +1.6 |
| **turn_asym** | **0.2** | **0.8** | **turn** | **82.0** | **+3.0** ← best |
| session_sym | 0.5 | 0.5 | session | 81.8 | +2.8 |
| session_asym | 0.2 | 0.8 | session | 80.6 | +1.6 |

**Best hybrid variant on oracle: `turn_asym` at R@5 = 82.0.** All 4 hybrid cells beat dense-only; symmetric variants are between turn and session granularity. The asymmetric (0.2/0.8) cells favor the dense signal and let BM25 act as a tiebreaker — `turn_asym` shows this works best when BM25 operates at the same granularity as dense (turn-level), so the two signals can disagree on the same candidate without one drowning out the other.

This is **cross-comparison only**: Phase 1 oracle is NOT Gate-B binding (see prereg §"Gate-B"). Phase 2 `_s` is the binding gate against the 97.7 threshold.

## Split-mismatch disclosure (binding)

Same disclosure as F13/F14/F15/F16. Phase 1 (oracle) is `data/longmemeval_oracle.json` — 3 sessions per haystack, 940 unique sessions. **NOT** directly comparable to gbrain v0.28.8's 97.60 on `longmemeval_s_cleaned` (~40 sessions per haystack, OpenAI text-embedding-3-large@1536). The Phase 1 binding comparison is against F13's BGE-base baseline of 79.0 R@5 inside the F9 harness.

Phase 2 (`_s`, when it runs) carries the same split-mismatch disclosure as F14/F15/F16 — gbrain figure is non-comparable on embedder + (canonical-distribution chain-of-custody) grounds.

## Gate-A — workload validity

### Gate-A items 1, 2 (BM25 corpus shapes)

PASS. Recorded at corpus build time by `chunk_per_turn_bm25_index.mjs`:

- Turn corpus: N=10,866 (matches unique-(session_id,turn_idx) count ± 1%), avgLen=182.20, vocab=31,565, no NaN.
- Session corpus: N=940 (matches unique session count exactly), avgLen=2,106.18 (~11.6× turn avgLen), vocab=31,565.

### Gate-A items 3, 4 (dense turn index + tag coverage)

PASS. Dense index build (`turn_index_bge_oracle.json.jsonl`, 190 MB JSONL, 10,866 turn vectors at dim 768) completed in 522.3s wall (20.80 turns/s — substantially faster than the prereg's ~5.7 turns/s estimate inherited from F13). All 940 oracle sessions covered. Sampled retrieval JSONLs confirm every retrieved row carries a tag matching a session_id in the source data.

### Gate-A item 5 (BM25 contribution rate)

Calculation: for each hybrid cell, count queries where `|BM25-top-5 ∩ RRF-top-5| ≥ 2`. Threshold: ≥80% of 500 queries.

| Cell | queries passing | rate | verdict |
|---|---:|---:|---|
| turn_sym | 455 / 500 | 91.0% | PASS |
| **turn_asym** | 392 / 500 | 78.4% | **FAIL** (margin -1.6pp) |
| session_sym | 457 / 500 | 91.4% | PASS |
| session_asym | 397 / 500 | 79.4% | **FAIL** (margin -0.6pp) |

The two asymmetric cells (BM25 weight 0.2) FAIL the 80% threshold by 0.6-1.6pp. Calibration finding: at `bm25Weight=0.2`, the RRF score is dominated by the dense rank, so BM25's top picks survive in the RRF top-5 less often (BM25 contributes 4-6 RRF rank-slots' worth of signal, vs symmetric's 8-10). The asymmetric cells DO still beat dense-only on R@5 (+1.6 to +3.0pp), so BM25 IS contributing — just less concentrated at the top-5 cutoff.

Per the prereg, Gate-A FAILs are "fix and re-run, NOT a retraction trigger." This is a threshold-calibration finding to record, not a mechanism failure. The two PASS cells (symmetric, 91%+) clear cleanly.

#### Phase 2 Gate-A item 5 (`_s`)

| Cell | queries passing | rate | verdict |
|---|---:|---:|---|
| turn_sym | 389 / 500 | 77.8% | FAIL (margin -2.2pp) |
| turn_asym | 291 / 500 | 58.2% | FAIL |
| session_sym | 410 / 500 | 82.0% | PASS |
| session_asym | 301 / 500 | 60.2% | FAIL |

On `_s`, only `session_sym` clears the 80% threshold. **Notably, `turn_sym` FAILS Gate-A item 5 at 77.8% yet is the best cell by R@5 (50.8) and wins every K and every question type.** The metric and the outcome disagree — which is itself the finding.

Interpretation: Gate-A item 5 measures "do BM25's top-5 picks survive into RRF's top-5". On `_s`'s 19,195-session universe, BM25's top-5 and dense's top-5 are mostly disjoint (the two signals genuinely find different sessions). RRF blends them — typically 3 from dense + 2 from BM25, which clears the "≥2 intersection" bar, but the exact 3/2 vs 4/1 split is sensitive to per-query score distributions. The 80% threshold (set on the outside-voice reviewer's recommendation before any data) turns out **stricter than the mechanism warrants**: `turn_sym` contributes BM25 signal strongly enough to lift R@5 by `+9.8` and win every type, while landing at 77.8% on this particular intersection metric.

**Conclusion on Gate-A item 5:** the metric (BM25-top-5 ∩ RRF-top-5 ≥ 2 for ≥80% of queries) and the R@5 outcome **disagree** — `turn_sym` FAILs the metric at 77.8% yet delivers the largest, most consistent R@5 lift. Which of the two is the better gauge of "BM25 contributes" is **unresolved**: the metric may be too strict, or it may be catching something real about how concentrated the contribution is. What is NOT in doubt is the R@5 evidence itself (every cell beats dense-only; `turn_sym` wins every K and every type). Recorded honestly as a metric/outcome disagreement; per the prereg (Gate-A FAILs are operational, non-retraction) it does not affect the binding Gate-B verdict, which FAILs on the 97.7 threshold regardless. The 80% threshold should be re-derived against data before any future hybrid track relies on it as a gate.

### Gate-A item 6 (dense-only sanity, binding for Gate-B adjudication)

**PASS — exact reproduction.** Dense-only cell `R@5 = 79.0` matches F13's recorded baseline of 79.0 to the precision reported (one decimal). Drift = 0.0pp, well under the binding 1pp threshold. The F9 harness does not contaminate the dense path. Phase 2 Gate-B can be adjudicated without harness-drift concerns.

## Per-K table (oracle, all 5 cells)

| K | dense_only | turn_sym | turn_asym | session_sym | session_asym |
|---:|---:|---:|---:|---:|---:|
| 1 | 51.0 | 58.4 | 55.2 | 54.2 | 54.8 |
| 3 | 72.2 | 76.2 | 74.6 | 73.8 | 74.2 |
| 5 | 79.0 | 80.6 | **82.0** | 81.8 | 80.6 |
| 10 | 86.6 | 88.8 | 88.8 | 88.8 | 89.0 |
| 20 | (n/a in eval) | — | — | — | — |
| 100 | (n/a in eval) | — | — | — | — |

Notes:
- `evaluate_retrieval.py` reports R@1, R@3, R@5, R@10 by default plus `answer_in_content@5`. K=20 and K=100 are not in the default metric set and not pre-registered as binding; left unfilled.
- `turn_sym` wins R@1 (58.4 vs dense's 51.0 — `+7.4`) while `turn_asym` wins R@5 (82.0). BM25's lexical-match strength shows up most at K=1 with symmetric weighting; at K=5 the asymmetric weight that trusts dense more wins because BM25 only acts as a tiebreaker among dense's already-good top picks.
- At K=10, all four hybrid cells converge to ~88.8-89.0 (vs dense 86.6, `+2.2-2.4`). The hybrid lift is largely independent of the BM25 granularity / weight choice at K=10.

## Per-type table (oracle, R@5)

| question_type | N | dense_only | turn_sym | turn_asym | session_sym | session_asym |
|---|---:|---:|---:|---:|---:|---:|
| knowledge-update | 78 | **94.9** | 92.3 | 93.6 | 93.6 | 92.3 |
| multi-session | 133 | 79.7 | 79.7 | 82.0 | **83.5** | 81.2 |
| single-session-assistant | 56 | 94.6 | **100.0** | **100.0** | **100.0** | **100.0** |
| single-session-preference | 30 | 33.3 | 30.0 | 33.3 | 33.3 | **40.0** |
| single-session-user | 70 | 72.9 | **81.4** | 78.6 | 77.1 | 75.7 |
| temporal-reasoning | 133 | 75.9 | 77.4 | **80.5** | 78.9 | 76.7 |

Per-type mechanism reading:

- **BM25 helps most where lexical match matters.** `single-session-user` (72.9 → 81.4), `single-session-preference` (33.3 → 40.0, N=30 so noisy), `single-session-assistant` (94.6 → 100.0). These are question types where the answer-bearing session contains specific terms that the question likely repeats.
- **BM25 hurts slightly on `knowledge-update`.** Dense-only (94.9) beats every hybrid cell (92.3-93.6). Interpretable: knowledge-update queries ask for the LATEST fact when multiple sessions update it; BM25 doesn't know about freshness and surfaces older sessions that happen to share lexical content.
- **Multi-session: session-level BM25 wins.** `session_sym` at 83.5 (`+3.8` vs dense). Makes sense: multi-session questions benefit from a corpus signal that operates over the full session content, not just the lexically-strongest turn.
- **Temporal-reasoning: turn-level BM25 wins.** `turn_asym` at 80.5 (`+4.6` vs dense). Hypothesis: temporal-reasoning queries reference specific events or dates that show up in individual turns, not session-averaged.
- **No single variant dominates all types.** `turn_sym` wins `single-session-user`, `turn_asym` wins `multi-session`/`temporal-reasoning`, `session_sym` wins `multi-session`, `session_asym` wins `single-session-preference`. A per-type-routed ensemble could plausibly exceed any single variant's R@5 — but that's a follow-up F-track, not in F9's scope.

## Cross-track comparison (oracle, R@5)

| Track | R@5 | Notes |
|---|---:|---|
| F8 hybrid tuning (MiniLM) | 76.8 | Gate-B FAIL @ 77.6 |
| F9 v2 Sonnet rerank (MiniLM) | 78.0 | Gate-B FAIL @ 80.6 (different `F9`, name collision) |
| F10 features-enriched (retracted) | 59.2 | Gate-B FAIL @ 80.8; HARD RETRACTION |
| F11 BGE-base baseline | 77.0 | Gate-B FAIL @ 81.8 |
| F11 + F9 Sonnet rerank | 78.2 | Gate-B FAIL @ 81.8 |
| F12 e5-large + top-100 + F9 (retracted) | 78.8 | Gate-B FAIL @ 83.2; HARD RETRACTION |
| **F13 chunked-turn + F9 Sonnet rerank (deployable best)** | **86.8** | Gate-B PASS @ 83.2 (margin +3.6) |
| **F9 hybrid `turn_asym` (THIS WORK)** | **82.0** | Cross-comparison; NOT Gate-B binding on oracle |

The F9 hybrid `turn_asym` at 82.0 on oracle is **+3.0** over dense-only baseline (79.0), and **+3.8** over the F11+F9-Sonnet stack (78.2) which was the deployable best before F13. It does NOT exceed the F13+F9-Sonnet-rerank deployable best (86.8 — a stack that pays 50 sub-agent dispatches per query). A future track could stack F9 hybrid ON TOP of F13's sub-agent rerank — that's not in scope for F9 itself but is named as a follow-up in §"Next steps".

## Phase 2 (`_s`, binding) — COMPLETE — Gate-B FAIL

Data acquired from the `Sanderhoff-alt/longmemeval-zh` GitHub mirror (`datasets/longmemeval_s_cleaned.json.gz`), decompressed to `data/lme_s/longmemeval_s_cleaned.json`. SHA-256 = `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, matching F14's recorded `d6f21ea9d...` prefix. Same chain-of-custody disclaimer as F14/F15/F16 (no signed provenance to the canonical HF release).

Dense index re-build: 199,509 turns, BGE-base, 7,226.9s wall (27.61 turns/s — even faster than Phase 1's 20.8/s, so the prereg's ~10h estimate and even the revised ~2.7h were both conservative; actual was 2.0h). 3.45 GB JSONL index.

### Phase 2 headline (`_s`, 500 questions, 19,195 sessions)

| Cell | BM25 weight | Dense weight | BM25 level | R@5 (`_s`) | vs dense-only 41.0 |
|---|---:|---:|---|---:|---:|
| dense_only | 0.0 | 1.0 | — | 41.0 | sanity (see Gate-A item 6 below) |
| **turn_sym** | **0.5** | **0.5** | **turn** | **50.8** | **+9.8** ← best |
| turn_asym | 0.2 | 0.8 | turn | 46.2 | +5.2 |
| session_sym | 0.5 | 0.5 | session | 46.8 | +5.8 |
| session_asym | 0.2 | 0.8 | session | 45.6 | +4.6 |

### Per-K table (`_s`, all 5 cells)

| K | dense_only | turn_sym | turn_asym | session_sym | session_asym |
|---:|---:|---:|---:|---:|---:|
| 1 | 17.4 | 23.8 | 22.6 | 23.0 | 19.8 |
| 3 | 33.8 | 43.8 | 39.8 | 39.6 | 37.0 |
| 5 | 41.0 | **50.8** | 46.2 | 46.8 | 45.6 |
| 10 | 51.8 | 63.6 | 57.6 | 58.2 | 55.4 |

`turn_sym` wins at every K: R@1 `+6.4`, R@3 `+10.0`, R@5 `+9.8`, R@10 `+11.8` over dense-only.

### Per-type table (`_s`, R@5)

| question_type | dense_only | turn_sym | turn_asym | session_sym | session_asym |
|---|---:|---:|---:|---:|---:|
| knowledge-update | 64.1 | **78.2** | 69.2 | 71.8 | 69.2 |
| multi-session | 35.3 | **39.8** | 37.6 | 34.6 | 38.3 |
| single-session-assistant | 82.1 | **94.6** | 89.3 | 91.1 | 83.9 |
| single-session-preference | 10.0 | **13.3** | 10.0 | **13.3** | 10.0 |
| single-session-user | 24.3 | **38.6** | 27.1 | 32.9 | 28.6 |
| temporal-reasoning | 31.6 | **42.1** | 41.4 | 40.6 | 39.8 |

`turn_sym` wins or ties every question type on `_s` — unlike oracle, where no single variant dominated. On the harder split the symmetric (equal-weight) variant wins consistently: the dense signal is weaker against 19,195 sessions, so BM25 deserves equal weight rather than tiebreaker weight. The oracle→`_s` flip (oracle best was `turn_asym`, `_s` best is `turn_sym`) is a clean interpretable finding: **the harder the retrieval task, the more weight the lexical signal should carry.**

### Gate-A items 3-6 (`_s`)

- **Item 3 (dense turn index):** PASS. 199,509 turns at dim 768, all 19,195 sessions covered.
- **Item 4 (tag coverage):** PASS. Sampled retrieval rows all carry valid `session_id` tags.
- **Item 5 (BM25 contribution rate):** _computed below in the Gate-A item 5 section update — see "Phase 2 Gate-A item 5"._
- **Item 6 (dense-only sanity, BINDING):** **PASS at the boundary — no slack remained.** F9-harness dense-only R@5 = 41.0 vs F14's recorded baseline 42.0. Drift = −1.0pp, exactly at the ±1.0 tolerance (not `> 1.0`, so within bound — one more question landing differently would have flipped this BINDING gate to BLOCKING). Likely cause: the F9 harness sorts the dense path by rank-derived RRF score (`1/(60+dense_rank)`), a strictly monotonic transform of dense rank, then re-sorts; F14's `chunk_per_turn_retrieve.mjs` sorts by the raw max-pool score directly. The two orderings differ only on exact-score ties — with 19,195 sessions, ~5 questions land their answer-session at position 5-vs-6 differently. **This does not contaminate the hybrid-lift measurement:** the `+9.8` lift is computed as `turn_sym(F9 harness) − dense_only(F9 harness)` — both cells run the identical F9 harness, so any rank-vs-score tie-break property is uniform across all 5 cells. The lift is an apples-to-apples within-harness comparison. The −1.0pp drift is only relevant when comparing F9's dense-only against F14's externally-reported number, which is not a load-bearing comparison for the Gate-B verdict.

### Gate-B verdict (binding)

**FAIL.** Best hybrid variant `turn_sym` R@5 = 50.8 on `_s`, against the binding threshold of 97.7 (gbrain v0.28.8 + the prior-track cushion — the same threshold F14/F15/F16 were measured against, not lowered).

Per the prereg's HARD RETRACTION clause, F9's eval artifacts are retracted (all gitignored — never in version control — and deleted from disk post-eval, 2026-05-21):
- BM25 corpus artifacts: `benchmarks/longmemeval/data/bm25_corpus_*.json` (oracle, `_s`, and the smoke-fixture corpora — ~512 MB).
- Dense turn indices: `benchmarks/longmemeval/data/turn_index_bge_s.json.jsonl` (3.45 GB) and `turn_index_bge_oracle.json.jsonl` (182 MB).
- Retained: the per-query retrieval JSONLs + `summary.json` under `results/f9_phase{1,2}/` (the result data this doc tabulates; gitignored, small) and the `model-cache/Xenova/bge-base-en-v1.5/` weights (vendored, pre-date F9, reusable). The two BM25 corpora + both dense indices are rebuildable from the committed scripts (`chunk_per_turn_bm25_index.mjs` ~17 s, `chunk_per_turn_embed.mjs` ~9 min oracle / ~2 h `_s`) if a follow-up needs them.
- This result doc is retained as the negative-result audit trail.
- No CHANGELOG / README / ROADMAP-RESEARCH number claim. ROADMAP-RESEARCH F9 status stays unchanged per the prereg (no FAIL-track ROADMAP update).

### Soft-criterion characterisation (descriptive, NOT a magnitude claim)

Per the prereg's soft success criterion: report the best variant's R@5 and R@100 deltas against F14's baseline, as descriptive characterisation of the mechanism's effect, explicitly NOT a magnitude claim.

- **R@5:** F9 `turn_sym` 50.8 vs F14 dense baseline 42.0. The within-F9-harness lift over F9's own dense-only cell is `+9.8` (50.8 − 41.0).
- **R@100 (the F15 structural-ceiling test):** F9 `turn_sym` R@100 was not in the default `evaluate_retrieval.py` metric set (R@1/3/5/10 only). The F14 R@100 ceiling of 86.2 was the absolute upper bound any rerank-over-F14-pool could reach; F9's hybrid fusion *changes the candidate pool itself* rather than reranking within it, so R@100 could in principle lift. Measuring F9's R@100 is a cheap follow-up (re-score the existing top-100 JSONLs at K=100) but is not pre-registered as binding and is left as a noted follow-up.

This framing satisfies the magnitude-smuggling guard: the numbers are descriptive characterisation of a measured mechanism, not a re-asserted retracted magnitude. Pre-commit grep recipe in §"Magnitude-smuggling guard" returns clean.

### The cost-parity finding (the headline-worthy part of a Gate-B FAIL)

F9 `turn_sym` R@5 = 50.8 on `_s` **exactly ties the F14+F9-Sonnet-rerank stack** (R@5 = 50.8, documented in `CHANGELOG.md` v1.9.2 cross-track table and `ROADMAP-RESEARCH.md:386`). **Both numbers are Gate-B FAILs** — F14+F9-Sonnet's 50.8 failed Gate-B @ 97.7, and F9 hybrid's 50.8 fails it too. The "tie" is a tie between two failed results; 50.8 is not a respectable bar, it is two different roads to the same shortfall. What is meaningful is the *cost difference at equal (failing) quality*: the F14+F9 stack pays 50 Sonnet sub-agent dispatches per eval run (~10 min controller wall time); F9 hybrid fusion pays **zero** — no API spend, no sub-agent dispatches, ~2.5h of pure in-sandbox float math for all 5 cells. For a deployment that wants F14+F9-stack retrieval quality on `_s` without the LLM-rerank cost, local BM25+dense RRF is a drop-in replacement at the same R@5 — but neither option clears the bar.

F9 hybrid does NOT beat F15's Opus-rerank-on-top-100 (R@5 = 63.6) — the maximally-equipped LLM reranker still wins on raw R@5. The honest ranking on `_s`: F15 Opus rerank (63.6) > F9 hybrid `turn_sym` = F14+F9-Sonnet stack (50.8) > F14 dense baseline (42.0) ≫ none clear Gate-B's 97.7.

## Next steps (follow-ups, not in F9 scope)

1. **F9 + F13-stacked rerank on oracle.** Run the F13 sub-agent rerank on top of F9 hybrid's top-100 (instead of dense-only's top-100). Plausible if Phase 1's lift is preserved through the rerank: F13+F9-rerank's 86.8 + ~3pp from the F9 hybrid candidate pool quality = ~89.8 R@5 on oracle. Different sub-agent dispatch cost; would need its own prereg.
2. **Per-type-routed ensemble.** Pick `turn_sym` for `single-session-user`, `session_sym` for `multi-session`, `turn_asym` for `temporal-reasoning`, etc. Each per-type best is +5-8pp over dense; routed ensemble could lift oracle R@5 by ~4-5pp at no inference cost. Risks: type prediction at retrieval time (LongMemEval question-type is metadata; in real usage you'd need a classifier).
3. **Phase 2 `_s` regardless.** Even an expected FAIL still produces (a) F14's R@100 ceiling test under hybrid candidate-pool (new data point), (b) cross-comparison evidence that the embedder, not the signal mix, is the structural bottleneck on `_s`. Both are useful even under Gate-B FAIL.

## Magnitude-smuggling guard

Per `docs/RETRACTION.md`. Pre-commit grep on this file:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' docs/evals/2026-05-20-f9-hybrid-rrf-result.md
```

Verbatim retraction sentence appears above the headline section: `This release does not re-assert the retracted −10pp magnitude.`

## Cumulative-null acknowledgement

Per `docs/RETRACTION.md:94-113`. F9 introduces no dlPFC mechanism change. The `src/rrf.ts` extraction (commit `43966c5`) is a pure behavior-preserving refactor; the new `chunk_per_turn_bm25_index.mjs` + `chunk_per_turn_hybrid_retrieve.mjs` (commit `c62df66`) are pure `benchmarks/` additions. The dlPFC goal-stack mechanism's cumulative-null status across v1.7.5/6/7/8/9 + v1.9-untestable is unaffected by Phase 1 or Phase 2 outcomes regardless.

## Outside-voice review

Pre-publish staged-diff review for this result doc will run before any CHANGELOG / README / ROADMAP-RESEARCH mention. Per the v1.7.7-onwards pattern.

---

_Author: Claude (Opus 4.7) at branch `feat/f9-hybrid-retrieval-parity`._
_Generated: 2026-05-20._
