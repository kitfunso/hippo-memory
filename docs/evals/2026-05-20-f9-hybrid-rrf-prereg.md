# LongMemEval R@5 target — F9 hybrid retrieval parity (BM25 + chunked-turn dense via RRF) — pre-registration

**Date:** 2026-05-20
**Plan:** `docs/plans/2026-05-20-f9-hybrid-retrieval-parity.md`
**Predecessors:**
- F13 baseline 79.0 / +F9-Sonnet-rerank 86.8 on oracle (Gate-B PASS, current cross-track best).
- F14 baseline 42.0 / +F9-Sonnet-rerank 50.8 on `_s` (Gate-B FAIL @ 97.7; HARD RETRACTION).
- F15 Opus-rerank 63.6 on `_s` (Gate-B FAIL @ 97.7; HARD RETRACTION).
- F16 e5-large chunked-turn 43.6 on `_s` (Gate-B FAIL @ 97.7; HARD RETRACTION).

This release does not re-assert the retracted −10pp magnitude.

---

## Pre-registration discipline gates (v1.8.1 rule)

Per `docs/RETRACTION.md` pre-registration discipline rule introduced in v1.8.1: no eval pre-commitment is binding without (a) source-read of the code paths the design depends on AND (b) a 1-question dry-run wired through the actual mechanism path confirming it FIRES.

### Gate (a) — source-read findings

Verified by reading `src/search.ts:28-97, 252-374` and `benchmarks/longmemeval/chunk_per_turn_{embed,retrieve}.mjs` on 2026-05-20 at master HEAD `1cc9f0d`. Recorded in full in the plan doc §2 ("Source-read findings"). Key facts that constrain F9's design:

- **`hybridSearch` already implements `scoring: 'rrf'` with `RRF_K=60`** (line 252-255, 354-374). F9 is plumbing, not novel mechanism.
- **`buildCorpus` + `bm25Score` + `tokenize` are public API** (line 28-97). F9's BM25 path reuses them.
- **`evaluate_retrieval.py` matches `retrieved_memories[*].tags` against `answer_session_ids`.** F9 output must tag each row with its parent `session_id` — same contract F13/F14 already satisfy.
- **No `src/` change required.** F9 is a pure `benchmarks/` addition. Cumulative-null status (`docs/RETRACTION.md:94-113`) is unaffected.

### Gate (b) — dry-run criterion (BLOCKING before any Gate-B run)

Task 3 of the plan: run the F9 hybrid retrieve against the synthetic_smoke fixture with N=1 question. Log artifact at `docs/evals/2026-05-20-f9-dry-run.md` must show:

- BM25 produces a non-empty session ranking (≥1 session with BM25 score > 0).
- Dense produces a non-empty session ranking (≥1 session with cosine score > 0).
- **STRONG criterion (revised after outside-voice review 2026-05-20):** at least one session in the **BM25 top-5** with positive BM25 score AND dense-rank > 50 appears in the **RRF top-10**. This proves BM25 is doing structural work — not just a tiebreaker swap at irrelevant positions. The original "at least one position-change" criterion was identified as a cheap-pass (would pass even at `bm25Weight = 1e-9`); the strong criterion forces measurable BM25 contribution.

If the dry-run fails the strong criterion, the mechanism is inert at the chosen weight and Gate-B is unfalsifiable. **BLOCKS pre-reg lock and any Phase 1 / Phase 2 run.**

This pre-reg is **NOT BINDING** until both gates are recorded in this file with PASS verdicts.

---

## Split-mismatch disclosure (binding)

F9 runs on **two** splits with different binding status:

**Phase 1 — oracle (`data/longmemeval_oracle.json`, 3 sessions per haystack, 940 unique sessions).** Cross-comparison only. F13 baseline = 79.0 R@5. F13+F9-Sonnet-rerank = 86.8. F9 oracle results are **NOT** Gate-B-binding. They serve only as: (i) confirmation the mechanism works at scale on the same corpus F13 validated, (ii) a per-K comparison surface against the F13 deployable best.

**Phase 2 — `_s` (`data/lme_s/lme_s.json`, ~48 sessions per haystack, 19,195 unique sessions).** Binding Gate-B. F14 baseline = 42.0 R@5. gbrain v0.28.8 hybrid = 97.60 R@5 (text-embedding-3-large + BM25 + RRF). The F9 vs gbrain comparison is NOT directly comparable: gbrain uses OpenAI's text-embedding-3-large (api.openai.com blocked from this sandbox per F14's egress audit) while F9 uses BGE-base. F9's binding comparison is against F14's BGE-base baseline.

**Data provenance disclaimer (binding):** F9's `_s` data is acquired from the `Sanderhoff-alt/longmemeval-zh` GitHub mirror, SHA-256 `d6f21ea9d...` (full hash recorded in F14's result doc), 500/500 question_id match against `longmemeval_oracle.json`, but NO signed chain-of-custody to the canonical HF release. Same disclaimer F14 / F15 / F16 carried. Any F9 result doc, CHANGELOG, README, or ROADMAP-RESEARCH mention must lead with this disclosure before any numerical claim.

---

## Magnitude-smuggling guard

Per `docs/RETRACTION.md`. Strict pre-commit grep on every result doc and every commit body that touches result artefacts:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' <file>
```

Verbatim retraction sentence — `This release does not re-assert the retracted −10pp magnitude.` — must appear on its own line in every result doc and every commit body touching result artefacts.

---

## Workload-validity gates (binding)

### Gate-A — workload validity (Phase 1 oracle + Phase 2 `_s`)

After building the BM25 corpora and re-confirming the dense index:

1. **BM25 turn corpus:** `N` (doc count) matches the unique `(session_id, turn_idx)` count from the source data (10,866 ± 1% on oracle; 199,509 ± 1% on `_s`). `avgLen > 0`, `df.size > 0`, no NaN in any score.
2. **BM25 session corpus:** `N` matches unique session count (940 oracle; 19,195 `_s`). `avgLen` substantially larger than the turn corpus (consistent with session = concat of turns). No NaN.
3. **Dense turn index:** every session_id from the source data has ≥1 turn vector in the index. Dim = 768 (BGE-base). L2-norm on a 100-row spot-check ∈ [0.999, 1.001].
4. **Tag coverage:** every output row from the eval run carries a tag matching a `session_id` in the source data (no orphan tags, no missing tags). Sampled at 100 rows.
5. **BM25 contribution rate (revised after outside-voice review 2026-05-20):** on the **full 500-question Phase 1 oracle eval**, for ≥80% of queries, the intersection `BM25-top-5 ∩ RRF-top-5` contains ≥2 sessions. This is the substantive analog of the original "differs by position" rate (which was identified as cheap-pass-vulnerable). It directly measures whether BM25's top picks survive the RRF fusion — if they don't, the dense signal dominates and the RRF cell is effectively dense-only.
6. **Dense-only sanity (binding):** the dense-only (1.0/0.0) cell reproduces F13's R@5 = 79.0 ± 1.0 on oracle and F14's R@5 = 42.0 ± 1.0 on `_s`. A drift > 1pp indicates F9-harness contamination and blocks any Gate-B verdict on the hybrid cells until investigated.

PASS = all 6 conditions. FAIL = fix and re-run, NOT a retraction trigger (Gate-A FAILs are operational bugs, not mechanism-effect verdicts). Exception: condition 6 (dense-only sanity drift > 1pp) BLOCKS Gate-B from being adjudicated until the drift is explained.

### Gate-B — proven value at R@5 (binding, HARD RETRACTION on FAIL)

**Phase 2 (`_s`) binding gate. Phase 1 (oracle) results are descriptive only.**

Best F9 variant — defined as `max(R@5)` across the **4 hybrid cells** of the 5-cell variant matrix (revised after outside-voice review 2026-05-20):

- turn × symmetric (0.5/0.5)
- turn × asymmetric (0.2/0.8) — replaced 0.4/0.6 to avoid memory-level-calibrated over-weighting of BM25 at turn granularity
- session × symmetric (0.5/0.5)
- session × asymmetric (0.2/0.8)

Plus a 5th **dense-only (1.0/0.0) sanity cell** that exists purely to confirm F14's 42.0 reproduces inside the F9 harness (per Gate-A condition 6). The dense-only cell does NOT compete for the Gate-B verdict — it's a contamination check.

The best hybrid variant must satisfy:

**R@5 ≥ 97.7%** on `data/lme_s/lme_s.json`, scored by `benchmarks/longmemeval/evaluate_retrieval.py`.

The 97.7 threshold is **the same threshold F14/F15/F16 were measured against** — gbrain v0.28.8's published 97.60 + the prior-track 0.1 cushion. F9 inherits the bar; it is not allowed to lower it on a different lever.

PASS = best F9 variant `recall@5 ≥ 0.977` on `_s`.

**FAIL** = best F9 variant `recall@5 < 0.977` on `_s` → **HARD RETRACTION**:
- Delete the BM25 corpus artifacts (`benchmarks/longmemeval/data/bm25_corpus_*.json`).
- Delete the F9-specific dense index re-build artifacts (`benchmarks/longmemeval/data/turn_index_bge_s_f9.json.jsonl` if any).
- Result doc retained as negative-result audit trail.
- CHANGELOG / README / ROADMAP-RESEARCH canonical docs NOT updated with F9 numbers.
- The cumulative-null status of the dlPFC goal-stack mechanism (`docs/RETRACTION.md:94-113`) is unaffected.

### Soft success criterion (NOT binding)

Gate-B is a high bar inherited from a different embedder (text-embedding-3-large vs BGE-base). A more interpretable secondary metric that the result doc must report:

**Mechanism-effect characterisation (descriptive):** report Δ R@5 for the best F9 variant vs F14's baseline of 42.0, and Δ R@100 vs F14's R@100 of 86.2. The Δ R@100 figure tests the F15-demonstrated "structural ceiling" claim: if RRF lifts R@100 meaningfully, the ceiling is not purely structural to BGE-base; if R@100 stays at ~86.2 ±2, the ceiling claim survives.

This is **descriptive characterisation, not a magnitude claim**, and any framing in the result doc must explicitly say so to satisfy the magnitude-smuggling guard.

---

## Cumulative-null acknowledgement

Per `docs/RETRACTION.md:94-113`. F9 adds:
- (i) `benchmarks/longmemeval/chunk_per_turn_bm25_index.mjs`
- (ii) `benchmarks/longmemeval/chunk_per_turn_hybrid_retrieve.mjs`
- (iii) BM25 corpus JSON artifacts (gitignored)
- (iv) this prereg + the result doc
- (v) **`src/rrf.ts` — a pure-refactor extraction** of the RRF math from `src/search.ts:354-374` (revised from "no `src/` change" after outside-voice review 2026-05-20). Behaviour-preserving: existing `npm test` stays green without modification. F9's benchmark imports `rrfFuse` from the new module; `hybridSearch` is updated to call the same helper.

F9 introduces no `src/` mechanism change. `buildCorpus`, `tokenize`, the RRF math (now extracted), and the embedding dispatch helpers are reused. The dlPFC goal-stack mechanism is independent of this evaluation, and a pure RRF-math refactor does not touch the dlPFC code path.

---

## Failure handling

- **Gate (a) source-read incomplete or contradicted by code reading:** stop, update §2 of the plan doc, re-run pre-reg.
- **Gate (b) dry-run shows inert RRF:** investigate why (token-set disjoint? weight imbalance?), fix, re-run dry-run. Pre-reg is NOT binding until dry-run shows mechanism FIRES.
- **Gate-A FAIL:** operational bug. Fix and re-run; NOT a retraction.
- **Gate-B FAIL:** HARD RETRACTION per the discipline above.

---

## Pre-registered cost and wall-time

| Operation | Wall time | Cost |
|---|---|---:|
| BM25 corpus build (oracle) | <5 min | $0 |
| BM25 corpus build (`_s`) | <30 min | $0 |
| Dense index re-build (`_s`, BGE-base) | ~10h | $0 |
| Hybrid retrieve (oracle, 500 queries × 4 cells) | <1h | $0 |
| Hybrid retrieve (`_s`, 500 queries × 4 cells) | ~2h | $0 |
| Result doc + outside-voice review | half day | $0 |

Total external API spend: **$0**. F9 runs entirely inside the sandbox with no blocked egress (BGE-base weights already vendored under F11; data acquired via the F14 GitHub mirror).

The `_s` dense-rebuild wall-time estimate was revised from F16's ~28h (e5-large) to ~10h (BGE-base) after outside-voice review noted the predecessor mismatch: F13 measured BGE-base on chunked-turn at ~5.7 turns/sec on this CPU; 199,509 turns at that rate ≈ 9.7h. Disk pre-check (≥10 GB free in `benchmarks/longmemeval/data/`) is required before kicking off — raw vectors are ~590 MB, JSONL overhead pushes the partial-file footprint to ~2-3 GB with resume slack.

---

## Provenance (to be completed during execution)

- **Datasets:**
  - Oracle: `data/longmemeval_oracle.json`, SHA-256 `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c` (matches F13's recorded hash).
  - `_s`: `data/lme_s/lme_s.json`, SHA-256 to be recorded during Task 5; must match F14's `d6f21ea9d...` or the prereg is suspended pending investigation.
- **Embedding model:** `Xenova/bge-base-en-v1.5` via @huggingface/transformers backend, vendored under F11 at `benchmarks/longmemeval/data/model-cache/Xenova/bge-base-en-v1.5/`. Pooling = CLS, no prefix (per `src/embeddings.ts::poolingFor` / `prefixFor`).
- **BM25 corpora:**
  - `benchmarks/longmemeval/data/bm25_corpus_turns_oracle.json` (gitignored, Task 1).
  - `benchmarks/longmemeval/data/bm25_corpus_sessions_oracle.json` (gitignored, Task 1).
  - `benchmarks/longmemeval/data/bm25_corpus_turns_s.json` (gitignored, Task 5).
  - `benchmarks/longmemeval/data/bm25_corpus_sessions_s.json` (gitignored, Task 5).
- **Turn dense indices:**
  - Oracle: reuse the F13-era index if any survived (`benchmarks/longmemeval/data/turn_index_bge.json.jsonl`); else re-build (~30-60 min).
  - `_s`: re-build via `chunk_per_turn_embed.mjs --model Xenova/bge-base-en-v1.5` (~28h).
- **Retrieve outputs:**
  - Oracle: `results/f9_oracle/{turn,session}_{sym,asym}.jsonl`.
  - `_s`: `results/f9_s/{turn,session}_{sym,asym}.jsonl`.
- **Eval outputs:** per-K + per-type tables embedded in the result doc.

---

## Outside-voice review

This prereg is dispatched for `/plan-eng-review` and `/codex` consult (cross-model adversarial) BEFORE Gate (b) dry-run. The dry-run must satisfy any pre-dry-run revisions the outside-voice reviewers identify (e.g., variant-confound fixes that change what the dry-run is measuring).

Result doc undergoes a separate outside-voice review before any CHANGELOG / README mention (per the v1.7.7-onwards pattern).

---

## Sunset condition for the magnitude-smuggling guard (no change)

Unchanged from F13/F14/F15/F16. The guard sunsets if and only if a future eval produces a discriminating workload (C2 hippo-base late mean within the N-lattice gate band) AND a properly pre-registered hypothesis test at that workload returns SUPPORTED with paired CI lower bound > 0. F9 is a retrieval-quality eval, NOT a goal-stack mechanism test, so it cannot sunset the guard regardless of outcome.

---

_Pre-reg author: Claude (Opus 4.7) at master HEAD `1cc9f0d` on 2026-05-20._
_Status: **NOT YET BINDING** — pending Gate (a) source-read confirmation in this file (recorded above) and Gate (b) dry-run artifact landing at `docs/evals/2026-05-20-f9-dry-run.md`._

---

## Outside-voice review trail

**2026-05-20 — senior-code-reviewer sub-agent — PASS_WITH_NOTES.** Five findings consolidated and applied:

1. (HIGH) Gate (b) dry-run criterion strengthened from "at least one position-change" to "BM25-top-5 session with dense-rank > 50 must appear in RRF top-10" (cheap-pass vulnerability closed).
2. (HIGH) Gate-A item 5 relocated from "dry-run rate" to "full 500-question Phase 1 oracle rate" and tightened from "differs" to "`BM25-top-5 ∩ RRF-top-5 ≥ 2 sessions` for ≥80% of queries". Added new Gate-A item 6: dense-only sanity drift ≤ 1pp vs F13/F14 baseline as a binding harness-contamination check.
3. (MEDIUM) `src/rrf.ts` extracted as a tiny pure-refactor helper instead of inline-copy. Both `hybridSearch` and F9 benchmark import `rrfFuse`. Cumulative-null section updated to reflect the `src/` change scope (still no mechanism change).
4. (MEDIUM) Variant matrix expanded from 4 cells to 5: added dense-only (1.0/0.0) sanity cell; replaced 0.4/0.6 with 0.2/0.8 (memory-level-calibrated default was structurally over-weighting BM25 at turn granularity).
5. (LOW) `_s` dense-rebuild wall-time revised from ~28h (e5-large era) to ~10h (BGE-base rate). Added explicit ≥10 GB disk pre-check.

PASS_WITH_NOTES verdict held after revisions. `/plan-eng-review` (interactive) and `/codex consult` (cross-model adversarial) remain pending pre-execution per the dev-framework PLAN exit criteria; flagged for Keith's session.
