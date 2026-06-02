# L1 graph-retrieval stream — pre-registration

**Date:** 2026-06-02
**Plan:** `docs/plans/2026-06-02-l1-graph-rrf-stream.md`
**Episode:** `01KT5302T7P2E2RGSZBMSMH03Y`
**Predecessor discipline:** mirrors `docs/evals/2026-05-20-f9-hybrid-rrf-prereg.md` (pre-registration gates rule, v1.8.1).

## Scope of this pre-registration (binding)

This pre-registers the **hippo-native mechanism ablation** for the L1 graph-retrieval stream.
It is **NOT** the LongMemEval-oracle population ablation: the F9 oracle harness fuses
*session_ids* and LME has no native hippo entity graph, so an oracle-split graph stream
requires E3.1 extraction over ~199K LME turns — a separate eval-infra lift deferred as
**L1-eval**. Per the plan's claim-scoping clause, a PASS here proves *"the mechanism
rescues the targeted lexically-weak-but-graph-adjacent class without harming controls,"*
**not** a population-level R@5 lift on a representative query distribution (that is L1-eval).

## Gate (a) — source-read findings (PASS)

Read at worktree HEAD = `origin/master` `20cfcc2` (v1.20.0), 2026-06-02. Recorded in the plan §2. Key facts that constrain the design:
- `rrfFuse` (src/rrf.ts) is generic over N ranked lists; `absentRank` is passed explicitly as `entries.length+1` and is independent of the list count → adding a 3rd list does not change the BM25/dense streams' absent-contribution.
- `hybridSearch` rrf path (src/search.ts:466-482) builds `bm25Ranked` + `cosineRanked` over `entries[]` indices; `scoring:'rrf'` only, default `'blend'`; `entries[]` already bi-temporally filtered before fusion.
- rrf-mode has zero production callers; the F9 benchmark calls `rrfFuse` directly in the `.mjs`, not through `hybridSearch` → the wiring is additive/opt-in and does not touch the F9 benchmark.
- Graph read helpers (`loadEntitiesByMemoryId`/`loadEntitiesByIds`/`loadNeighborRelations`) are SELECT-only and already imported by graph-recall.ts; a sibling read-only module is E3.3-lint green.

**Verdict: Gate (a) PASS** (plan-eng-critic independently verified each claim, score 82).

## Gate (b) — dry-run "structural work" criterion (PASS)

Test: `tests/search-graph-stream-rrf.test.ts` — "Gate-(b) dry-run" case, real SQLite.
Fixture: an 8-entry pool; the answer (`weak`, index 7) is lexically last in BOTH the BM25
and dense rankings (rank 8/8) but graph-adjacent (1-hop) to a top lexical seed (`strong`,
index 0). Seeds = top-3 lexical (`weak` is NOT a seed). Weights `[0.4, 0.6, 0.5]`,
`absentRank = 9`, `k = 60`.

Measured fused ranks of the answer:
- **2-stream (BM25 + dense):** rank **8/8** (outside top-5).
- **3-stream (+ graph):** rank **4/8** (inside top-5).

The answer is lexically-weak-but-graph-adjacent and moves from rank 8 to rank 4 purely
from the graph stream — structural work, not a tiebreaker swap at irrelevant positions.

**Verdict: Gate (b) PASS.**

## Binding gate (Gate-B, this episode)

- **G (mechanism):** the targeted lexically-weak-but-graph-adjacent answer enters top-5
  under the 3-stream fusion when it was outside top-5 under the 2-stream baseline. **MET**
  (rank 8/8 → 4/8).
- **C (no-harm):** a strong lexical answer with no graph path keeps its top rank; an empty
  graph yields an empty stream and the 2-list path is taken unchanged. **MET** (control
  answer stays rank 1; `graphRankStream` returns `[]` → 3rd list skipped).
- **Honest-null clause:** had G not improved or C dropped, the mechanism would still ship
  as opt-in infra with the null disclosed and **no "lifts R@5" claim**.

This pre-registration is **LOCKED** (both gates PASS). Result: `2026-06-02-l1-graph-stream-result.md`.
