# F9 — Hybrid retrieval parity: BM25 + chunked-turn dense via RRF — implementation plan

**Date:** 2026-05-20
**Track:** ROADMAP-RESEARCH.md "Track F item F9 — Hybrid-retrieval parity + competitive consolidation [critical, next]"
**Predecessors:**
- F13 chunked-turn dense baseline on oracle (R@5 = 79.0 baseline, +F9-sub-agent-rerank stack = 86.8, Gate-B PASS; current deployable cross-track best). `docs/evals/2026-05-12-r5-track6-chunk-per-turn-result.md`.
- F14 chunked-turn dense baseline on `_s` (R@5 = 42.0 baseline, +F9-sub-agent-rerank = 50.8, Gate-B FAIL @ 97.7). `docs/evals/2026-05-12-r5-track7-s-split-result.md`. HARD RETRACTION executed; result doc retained as negative-result audit trail.
- F15 Opus-rerank on F14 top-100 (R@5 = 63.6 baseline, Gate-B FAIL @ 97.7). HARD RETRACTION executed.
- F16 e5-large chunked-turn on `_s` (R@5 = 43.6 baseline, Gate-B FAIL @ 97.7). HARD RETRACTION executed.

This release does not re-assert the retracted −10pp magnitude.

---

## 1. Motivation

After F14 / F15 / F16 all Gate-B FAILed on `_s` against gbrain v0.28.8's 97.60, the cumulative read of the F-track is:

- The locally-runnable embedder lever is **measured and flat** (F16 vs F14: +1.6 R@5, −1.4 R@100, both within noise).
- The within-pool LLM-rerank lever is **measured and 1/3 of the way home** (F15 closes 48.9% of the within-pool ranking gap vs F14+F9's 19.9%, but `R@100 = 86.2` is a structural ceiling — even a perfect rerank cannot exceed it).
- The remaining levers split into two paths: (a) a qualitatively different embedder (F17 `text-embedding-3-large`, blocked on `api.openai.com` egress), and (b) **a fundamentally different retrieval signal** — keyword/lexical matching via BM25, fused with the dense signal via RRF.

gbrain's own ablation table is the existing public evidence that hybrid fusion matters on this corpus:

| gbrain v0.28.8 ablation | R@5 on `_s` |
|---|---:|
| BM25 only | 19.80 |
| Vector only (text-embedding-3-large@1536) | 97.40 |
| Hybrid (BM25 + vector + RRF) | 97.60 |

Two observations from that table that motivate F9:

1. **Hybrid moved +0.2pp over pure vector at gbrain's scale.** That looks small until you contextualise: F15's maximally-equipped sub-agent rerank at 100 candidates with 1000-char context closed 48.9% of the within-pool gap, and that's still 34.1pp short of Gate-B. A +0.2pp move from RRF was free in gbrain's pipeline because BM25 ran on the same vendor that exposed dense. It is exactly the kind of "small lever, structural, never tried" that the cumulative-null status of the F-track demands we measure before declaring locally-runnable retrieval exhausted.

2. **Hippo's `hybridSearch` already implements BM25 + RRF in `src/search.ts`.** A `scoring: 'rrf'` mode exists (line 252-255), with `RRF_K = 60` (the standard) and a default `bm25Weight=0.4` / `embeddingWeight=0.6`. F9 is therefore not a research-novel mechanism — it's plumbing the existing hippo machinery into the F13/F14 chunked-turn pipeline that the F-track has been measuring. The BM25 corpus builder (`buildCorpus`), tokenizer (`tokenize`), and RRF math (line 354-374) are all already shipped under `npm test`-covered code paths.

The "novel" thing F9 measures is not "does RRF work" (a well-established result) but **whether RRF works on hippo's chunked-turn pipeline as currently shaped, and whether the F14 R@100 candidate-pool ceiling holds when the candidate pool is built from the union of two signals rather than one**. The latter directly addresses the structural ceiling F15 demonstrated.

## 2. Source-read findings (v1.8.1 discipline gate, requirement (a))

Verified by reading `src/search.ts:28-97, 252-374` and `benchmarks/longmemeval/chunk_per_turn_{embed,retrieve}.mjs` on 2026-05-20 at master HEAD `1cc9f0d`. Findings:

| Component | Status | Reuse path |
|---|---|---|
| BM25 corpus builder | Shipped (`src/search.ts::buildCorpus`) | Use directly from benchmark — `import { buildCorpus, tokenize } from '../../dist/src/search.js'` |
| BM25 tokenizer | Shipped (`src/search.ts::tokenize`) | Same import; consumes lowercased text, strips punctuation, length-2+ filter |
| RRF math | Shipped (`src/search.ts:354-374`, `RRF_K=60`) | Extract to a tiny `src/rrf.ts` helper (10-15 lines, no `MemoryEntry` coupling) that both `hybridSearch` and the F9 benchmark import. Avoids the divergence risk of inline-copy if `RRF_K` or the missing-rank convention (`entries.length + 1`) is tuned later. The `src/rrf.ts` extraction is a pure refactor: behaviour-preserving, covered by existing tests, no mechanism change. The dlPFC cumulative-null status (`docs/RETRACTION.md:94-113`) is unaffected. (Revised from inline-copy after outside-voice review 2026-05-20.) |
| Per-model dispatch (pooling/prefix/backend) | Shipped (`src/embeddings.ts`, v1.9.0+) | `chunk_per_turn_embed.mjs` already uses it (BGE → CLS pooling, no prefix; e5 → mean pooling, `passage:` / `query:` prefix). |
| Chunked-turn embed | Shipped (`benchmarks/longmemeval/chunk_per_turn_embed.mjs`) | Output JSONL is the F9 dense signal source. Reuse the F14 BGE-base `turn_index_bge_s.json.jsonl` shape when running on `_s` (need to re-build since F14's was deleted on HARD RETRACTION). |
| Chunked-turn retrieve | Shipped (`benchmarks/longmemeval/chunk_per_turn_retrieve.mjs`) | Provides the dense-only baseline (F13/F14). F9 adds a **parallel BM25 path** with the same max-pool-to-session aggregation, then RRF-fuses the two session orderings. |
| `evaluate_retrieval.py` matching contract | Shipped (matches `retrieved_memories[*].tags` against `answer_session_ids`) | Unchanged by F9. Output format must tag each retrieved row with the parent `session_id`. |

**`src/` change scope: ONE pure-refactor file (`src/rrf.ts`, ~15 lines extracted from `search.ts:354-374`, no behaviour change, no mechanism change).** F9's *eval-bearing* changes are all in `benchmarks/longmemeval/`. The dlPFC goal-stack mechanism's cumulative-null status (`docs/RETRACTION.md:94-113`) is unaffected by a pure RRF-math extraction. (Revised from "no `src/` change" after outside-voice review 2026-05-20.)

## 3. Design decisions (locked before pre-reg)

### Q1. BM25 granularity — turn-level vs session-level?

**Locked: BOTH measured, max() reported as the F9 best variant per Gate-B.**

Rationale:
- **Turn-level BM25** (one doc per ~550-char turn, max-pool to session): structural parity with the F13/F14 dense path. Sparse TF per doc but consistent with dense pipeline.
- **Session-level BM25** (one doc per ~14k-char session = concat of all turns): denser TF, more aligned with gbrain's likely setup. Closer to a "drop-in BM25 alongside the existing chunked dense" semantic.
- Running both is **~2x the eval cost but ~0x the implementation cost** (same BM25 code, different corpus shape). The per-K table reports both alongside the dense baseline for transparency.

### Q2. BM25 corpus universe — haystack-scoped or global?

**Locked: `_s` BM25 corpus = all 19,195 unique sessions across the 500 haystacks** (matches the F14 dense index universe). Oracle corpus = all 940 unique sessions (matches F13).

Rationale: BM25's IDF term is dominated by the global document count. A haystack-scoped corpus (≈48 sessions per haystack) would produce non-comparable IDFs per query and is closer to a contrived setup. Global is what gbrain reports.

### Q3. RRF weights — symmetric or asymmetric? + dense-only sanity cell

**Locked: 5 cells total (revised from 4-cell after outside-voice review 2026-05-20).**

The original draft was 4 cells: `{turn, session} × {0.5/0.5, 0.4/0.6}`. Outside-voice review identified two issues:
- `0.4/0.6` (the in-`src/` `hybridSearch` default) is calibrated for **memory-level** retrieval. At turn-granularity, BM25 firing rate per doc is much sparser, so 0.4 BM25-weight is structurally over-weighted relative to the per-doc evidence. Replaced with `0.2/0.8` ("BM25 as tiebreaker") as the principled turn-level baseline.
- A `1.0/0.0` (dense-only) sanity cell is required to confirm the F14 baseline reproduces *inside the F9 harness*. Without it, a 1pp drift between F14's literal-cited 42.0 and the F9 dense-only reproduction is invisible and silently contaminates the +Δ-vs-baseline read.

**Final matrix:**

| Cell | BM25 weight | Dense weight | BM25 granularity | Purpose |
|---|---:|---:|---|---|
| dense-only | 0.0 | 1.0 | (n/a) | Sanity: reproduce F14's 42.0 inside the F9 harness |
| turn × symmetric | 0.5 | 0.5 | turn | Standard equal-weight hybrid at turn granularity |
| turn × asymmetric | 0.2 | 0.8 | turn | BM25-as-tiebreaker at turn granularity |
| session × symmetric | 0.5 | 0.5 | session | Standard equal-weight hybrid at session granularity (closer to gbrain's likely setup) |
| session × asymmetric | 0.2 | 0.8 | session | BM25-as-tiebreaker at session granularity |

`RRF_K` is fixed at 60 (canonical Cormack et al. 2009, matches `src/search.ts:356`). Tuning `K` is **NOT** in scope for F9 — separate follow-up if the BM25-fusion lever produces a meaningful lift but no variant clears Gate-B.

### Q4. Dense embedder choice for F9 on `_s` and oracle?

**Locked: BGE-base.** Reasons:
- F14 (BGE-base on `_s`) and F13 (BGE-base on oracle) are the deployable baselines.
- F16 settled the embedder question: the GCS-reachable embedder lever is flat (e5-large vs BGE-base on `_s`: R@5 ±1.6, R@100 ∓1.4, within noise).
- A single embedder + variant matrix (turn / session × symmetric / asymmetric = 4 cells) is a tractable Gate-B surface. Multi-embedder is out of scope for F9.

### Q5. Splits — which to measure?

**Locked: oracle first (cross-comparison only), then `_s` (binding).**

- **Phase 1 — oracle (cross-comparison):** Cheap (940 sessions, ~11k turns, in-memory). F13 baseline is 79.0; F13+F9-Sonnet-rerank stack is 86.8 (current deployable cross-track best). F9 on oracle is **NOT** Gate-B-binding; it is a sanity check that the hybrid mechanism fires and produces a different ordering than dense-only.
- **Phase 2 — `_s` (binding):** F14 baseline is 42.0; gbrain hybrid is 97.6. Binding Gate-B against F14 baseline + measurable lift. Cost: ~30-60 min wall for index re-build (F14's was deleted on HARD RETRACTION), ~1 min for retrieve.

### Q6. Re-acquire `_s` data — same provenance as F14?

**Locked: yes, with the same chain-of-custody disclaimer.** F14 acquired `_s` from the `Sanderhoff-alt/longmemeval-zh` GitHub mirror (SHA-256 `d6f21ea9d...`, 500/500 question_id match against oracle, NO signed chain-of-custody to canonical HF release). F9 inherits the same data source and the same disclaimer. F14's data was deleted on HARD RETRACTION; F9 re-downloads. Hash must match the F14-recorded SHA before proceeding.

## 4. Tasks with explicit success criteria

Per Karpathy rule 4: every task has a verifiable check.

### Task 1 — BM25 corpus build script
File: `benchmarks/longmemeval/chunk_per_turn_bm25_index.mjs`
- Reads `data/longmemeval_oracle.json` (Phase 1) or `data/lme_s/lme_s.json` (Phase 2).
- For each unique `(session_id, turn_idx)` pair, builds a turn-level BM25 corpus.
- For each unique `session_id`, builds a session-level BM25 corpus (turns joined by `\n`).
- Writes two artifacts: `bm25_corpus_turns_{oracle,s}.json` and `bm25_corpus_sessions_{oracle,s}.json` (gitignored). Each artifact contains the tokenized docs + df map + avgLen + N (the `BM25Corpus` shape from `src/search.ts:45-50`).

**Verify:** `node` REPL or one-off script reads the artifact, runs `bm25Score(corpus, 0, tokenize("the"))`, gets a non-NaN finite number. Token counts in artifact stats logged: total docs, mean doc length, vocab size.

### Task 2a — Extract `src/rrf.ts` (pure refactor)

Extract the RRF math from `src/search.ts:354-374` into a standalone `src/rrf.ts` helper with signature:

```ts
export function rrfFuse(
  rankedLists: number[][],     // each inner array: 1-indexed ranks indexed by candidate id (0 means absent)
  weights: number[],            // per-list weights, summed
  k?: number,                   // default RRF_K = 60
  totalCandidates?: number      // default = max id + 1; used for absent-rank convention
): Map<number, number>;
```

Update `src/search.ts` to call `rrfFuse([bm25Ranked, cosineRanked], [bm25Weight, embeddingWeight])` instead of the inline math. Behaviour MUST be byte-identical: existing tests (`npm test`) pass without modification. F9 benchmark imports `rrfFuse` from `dist/src/rrf.js`.

**Verify:** Full `npm test` green, no test changes required.

### Task 2b — Hybrid retrieve script
File: `benchmarks/longmemeval/chunk_per_turn_hybrid_retrieve.mjs`
- CLI: `--turn-index <path>` (existing JSONL), `--bm25-turns <path>`, `--bm25-sessions <path>`, `--mode {turn|session}` (BM25 granularity), `--rrf-weight-bm25 <float>` (default 0.5), `--rrf-weight-dense <float>` (default 0.5), `--rrf-k <int>` (default 60), `--top-k <int>` (default 100), `--out <jsonl>`.
- For each query:
  1. Embed via the matching dense backend (BGE-base, mean pooling, no prefix — mirrors `chunk_per_turn_retrieve.mjs`).
  2. Compute per-turn cosine similarity against the turn index. Max-pool to session.
  3. Compute BM25 score per turn (turn mode) OR per session (session mode). For turn mode, max-pool to session.
  4. Build the session-rank list under each signal independently (descending by score).
  5. RRF-fuse via the new `rrfFuse` helper from `src/rrf.ts`. Sessions absent from a ranked list get rank `(N+1)`.
  6. Sort by RRF score, take top-K.
  7. Output JSONL matching `evaluate_retrieval.py`'s contract (each row tagged with its `session_id`).

**Verify:** Unit test against a tiny hand-built 5-session corpus where the expected RRF ordering is known a priori. Plus an invariant test that imports `RRF_K` from `src/rrf.ts` and asserts it equals 60 — this is the divergence-protection contract.

### Task 3 — Dry-run on synthetic smoke (v1.8.1 discipline gate (b))
- Run the retrieve script against `benchmarks/longmemeval/data/synthetic_smoke.json` with N=1 question. Use a pre-built tiny BM25 corpus + a tiny dense index.
- Confirm: BM25 produces a non-empty top-K (≥1 session with BM25 score > 0), dense produces a non-empty top-K, RRF ordering is **NOT identical** to either signal alone for the same query.
- **STRONG criterion (revised after outside-voice review 2026-05-20):** at least one session in the **BM25 top-5** with positive BM25 score AND dense-rank > 50 must appear in the **RRF top-10**. This proves BM25 is doing structural work — not just causing a tiebreaker swap at high dense-rank positions where it would matter little. The original "at least one position-change" criterion passes even if `bm25Weight = 1e-9`; the strong criterion forces measurable BM25 contribution.
- **Block on:** strong criterion fails. That proves the BM25 path is effectively inert at the chosen weight; investigate (token-set disjoint, weight imbalance, corpus build bug) before pre-reg can lock.

**Exit:** Dry-run log artifact at `docs/evals/2026-05-20-f9-dry-run.md` shows: query, BM25 top-5 session_ids with scores, dense top-5 session_ids with scores, RRF top-10 session_ids with scores, **and an explicit assertion line** demonstrating the strong criterion was met (e.g., "BM25-top-5 session `s_xyz` had dense_rank=73 and appeared at RRF rank 6 — strong criterion PASS").

### Task 4 — Oracle Phase 1 (cross-comparison)
- Build BM25 corpora over oracle: `bm25_corpus_{turns,sessions}_oracle.json`.
- Run the hybrid retrieve for all **5 cells** of the variant matrix (see §3 Q3):
  - dense-only (1.0 / 0.0) — sanity reproduction of F13's 79.0 inside the F9 harness
  - turn × symmetric (0.5 / 0.5)
  - turn × asymmetric (0.2 / 0.8)
  - session × symmetric (0.5 / 0.5)
  - session × asymmetric (0.2 / 0.8)
- Score each via `evaluate_retrieval.py`.
- **Sanity gate (BLOCKING for Phase 2 entry):** dense-only cell must reproduce F13's R@5 = 79.0 ± 1.0. A drift > 1pp indicates harness contamination and blocks Phase 2 until investigated.
- Compare each hybrid cell against the F13 baseline (R@5 = 79.0) and the F13+F9-Sonnet-rerank stack (R@5 = 86.8).
- Per-K table: K ∈ {1, 3, 5, 10, 20, 100}.

**Exit:** All 5 cells produce numbers; per-K table written to draft result doc. Dense-only sanity gate PASS. No Gate-B binding on oracle.

### Task 5 — `_s` Phase 2 (binding)
- Re-acquire `_s` data from `Sanderhoff-alt/longmemeval-zh` GitHub mirror; verify SHA-256 against F14's recorded `d6f21ea9d...`.
- Re-build the BGE-base chunked-turn dense index (~199k turns). **Estimated ~10h wall** at the F13-measured BGE-base rate of ~5.7 turns/sec on this CPU (revised from the F16-era ~28h figure which was e5-large, not BGE-base). Resume-safe JSONL writer (v1.9.3 fix already shipped in `chunk_per_turn_embed.mjs`).
- **Disk pre-check:** confirm ≥10 GB free in `benchmarks/longmemeval/data/`. Raw vector size ~590 MB (199k × 768-dim FP32), JSONL overhead ~3-4×, plus partial-file slack during resume. F14/F16 history shows the JSONL bloat factor in practice.
- Build BM25 corpora over `_s`: `bm25_corpus_{turns,sessions}_s.json`.
- Run the hybrid retrieve for all **5 cells** (including dense-only sanity).
- Score via `evaluate_retrieval.py`.
- **Sanity gate (binding):** dense-only cell must reproduce F14's R@5 = 42.0 ± 1.0. A drift > 1pp blocks the Gate-B verdict on hybrid cells until investigated.
- Compare against F14 baseline (R@5 = 42.0) and gbrain v0.28.8's 97.60 (split-mismatch disclosure required).

**Exit:** Result doc `docs/evals/2026-05-20-f9-hybrid-rrf-result.md` with per-K + per-type tables for all 5 cells, dense-only sanity gate verdict, plus the binding Gate-B verdict on the best hybrid variant.

### Task 6 — Result doc + canonical-doc updates
- Result doc lands first with the verbatim retraction sentence and the cumulative-null acknowledgement section.
- If Gate-B PASS: CHANGELOG v1.9.4 entry, README "What's new in v1.9.4", ROADMAP-RESEARCH F9 status → shipped.
- If Gate-B FAIL: HARD RETRACTION per `docs/RETRACTION.md` discipline. Delete the BM25 corpus artifacts; CHANGELOG/README/ROADMAP NOT updated; result doc retained as negative-result audit trail.

## 5. Risks + rollback

| Risk | Mitigation |
|---|---|
| BM25 turn-level TF is too sparse to be useful (most query terms don't appear in any single turn). | Session-level variant is the safety net. The 4-cell matrix is designed to surface this. |
| `_s` re-download hash drifts from F14's recorded SHA. | Block on hash mismatch. Document the new hash in the result doc; do not proceed with eval until investigated. |
| Dense index build wall exceeds budget (estimated ~10h on `_s` at BGE-base rate; F16's 28h was e5-large, not BGE-base — revised after outside-voice review 2026-05-20). | Use F11's existing BGE-base index over the 940 oracle sessions for Phase 1; only Phase 2 needs the full `_s` index. Resume-safe JSONL writer (already in `chunk_per_turn_embed.mjs` per v1.9.3 fix). Pre-check disk ≥10 GB before kicking off. |
| RRF output is identical to dense-only (BM25 signal dominated to zero by the dense ranks). | Task 3 dry-run blocks this. If it happens at scale despite a green dry-run, investigate before any Gate-B claim. |
| Result doc misses the retraction-citation grep gate. | Pre-commit grep automated via the same recipe used in F13/F14: `grep -nE '(Δ\s*=\s*[0-9]\|[0-9]\s*pp\s*(lift\|drop\|≥\|−\|\+))' <file>` + `grep -q "This release does not re-assert"` on every result-doc and result-bearing commit body. |

**Rollback path:**
- Phase 1 (oracle): No production surface. Delete the BM25 corpus artifacts; no `src/` change to revert.
- Phase 2 (`_s`): Same. If a CHANGELOG/README entry was published prematurely and Gate-B FAILS, revert that commit before publication; deliberately blocked by the "result doc lands first" sequencing in Task 6.

## 6. Outside-voice review (PLAN exit criteria — REQUIRED)

Per dev-framework PLAN phase, minimum one outside voice before code. F9 dispatches **two** (research arc, four prior Gate-B FAILs on the same corpus, high prior for a structural pitfall):

1. **`/plan-eng-review`** — in-house architecture critique. Interactive. Will surface: any missing per-step success criteria, any data-flow contract drift between Tasks 1-5, any test-coverage hole in the dry-run gate.
2. **`/codex` (consult mode)** — cross-model adversarial. Will surface: design assumptions that would break Gate-B's interpretability (e.g. variant choice that introduces a confound).

Revisions consolidated into a "Plan revisions applied" appendix in this file before Task 1 starts.

## 7. Timeline (estimated)

| Phase | Wall time | Notes |
|---|---|---|
| Task 1 (BM25 corpora, oracle) | <5 min | Tokenize ~11k turns + ~940 sessions on a single core |
| Task 2a (`src/rrf.ts` extract) | half day | Pure refactor; existing tests must stay green |
| Task 2b (hybrid retrieve script) | ~1 day | Includes unit test for `rrfFuse` + invariant test for `RRF_K=60` |
| Task 3 (dry-run, strong criterion) | <30 min | Including the result doc artifact |
| Task 4 (oracle Phase 1 eval, 5 cells) | <1.5h | 500 queries × 5 cells; dense-only sanity gate enforced |
| Task 5 (`_s` Phase 2, 5 cells) | ~10h dense re-build + ~2.5h fuse | Index build dominates. Can run overnight. (Revised from ~28h after outside-voice review.) |
| Task 6 (result doc) | half day | Including outside-voice review of the result doc itself |
| **Total** | **~3-5d** | Matches the ROADMAP-RESEARCH F9 estimate ("~5d") |

## 8. Acceptance criteria

PLAN phase exits when:
- [ ] This plan doc and the prereg `docs/evals/2026-05-20-f9-hybrid-rrf-prereg.md` both exist on master (or a feature branch staged for merge).
- [ ] `/plan-eng-review` returned a PASS or PASS_WITH_NOTES verdict and any required fixes are applied.
- [ ] `/codex` consult returned no blocking findings (or findings are applied).
- [ ] Task 3 dry-run produced its log artifact showing the RRF mechanism FIRES (`docs/evals/2026-05-20-f9-dry-run.md`).
- [ ] Keith has signed off on the consolidated outside-voice revisions blob.

EXECUTE phase begins after all five.

---

_Plan author: Claude (Opus 4.7) at master HEAD `1cc9f0d` on 2026-05-20._
