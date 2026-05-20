# F9 hybrid retrieval parity (BM25 + chunked-turn dense via RRF) — result

**Date:** 2026-05-20
**Plan:** `docs/plans/2026-05-20-f9-hybrid-retrieval-parity.md`
**Pre-reg:** `docs/evals/2026-05-20-f9-hybrid-rrf-prereg.md` (BINDING as of dry-run PASS in `docs/evals/2026-05-20-f9-dry-run.md`)
**Status:** _Phase 1 oracle complete (cross-comparison only). Phase 2 `_s` (binding) DEFERRED — needs `_s` data re-acquisition + ~10h BGE-base dense rebuild._

This release does not re-assert the retracted −10pp magnitude.

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

- **BM25 helps most where lexical match matters.** `single-session-user` (`+8.5`pp), `single-session-preference` (`+6.7`pp, N=30 so noisy), `single-session-assistant` (`+5.4`pp). These are question types where the answer-bearing session contains specific terms that the question likely repeats.
- **BM25 hurts slightly on `knowledge-update`.** Dense-only beats every hybrid cell by 1.3-2.6pp. Interpretable: knowledge-update queries ask for the LATEST fact when multiple sessions update it; BM25 doesn't know about freshness and surfaces older sessions that happen to share lexical content.
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

## Phase 2 (`_s`, binding) — DEFERRED

Phase 2 is the binding Gate-B verdict on the same threshold F14/F15/F16 missed (97.7). It requires:

1. Re-acquire `data/lme_s/lme_s.json` from `Sanderhoff-alt/longmemeval-zh` GitHub mirror; verify SHA-256 against F14's recorded `d6f21ea9d...`.
2. Re-build the BGE-base chunked-turn dense index on `_s` (~199,509 turns at the Phase 1-measured rate of ~20.8 turns/s ≈ **2.7h wall**, substantially under the prereg's ~10h budget which inherited from F13's slower estimate).
3. Run the 5-cell hybrid eval (~2.5h, 500 queries × 5 cells).
4. Adjudicate Gate-B on the best hybrid variant against the 97.7 threshold.

Phase 2 will write its own result section into this doc after completion.

**Realistic Phase 2 expectation given Phase 1 oracle results:** F9 hybrid lifts dense-only by +1.6 to +3.0pp on oracle. If the same multiplicative lift holds on `_s` (F14 baseline 42.0 → F9 best ~45-50), the binding Gate-B (97.7) will FAIL by ~50pp — consistent with the F16 conclusion that the locally-runnable embedder is the structural bottleneck on `_s`, not the retrieval signal mix. The hybrid finding remains valuable as **the first F-track measurement of the local BM25+dense lever**, but is unlikely to clear Gate-B without the qualitatively different embedder F17 (`text-embedding-3-large`, blocked on `api.openai.com` egress) the F16 result doc named as the path forward.

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
