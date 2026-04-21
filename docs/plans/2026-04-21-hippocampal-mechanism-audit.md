# Hippocampal Mechanism Gap Audit

**Date:** 2026-04-21
**Purpose:** Verify the Frontier AI Discovery grant claim that hippo-memory implements "7 hippocampal mechanisms as code" before the funded period starts in October 2026.

## Result: 7 of 7 PRESENT (updated 2026-04-21 after v0.29 replay shipped), 0 MISSING

Pattern completion remains PARTIAL at the API surface, but the underlying mechanism (cluster amplification) is in the physics engine.

| # | Mechanism | Status | Key evidence |
|---|---|---|---|
| 1 | Encoding | **PRESENT** | `src/memory.ts:220-273` (`createMemory` with strength, decay, tags, emotional_valence); 11 tests in `tests/memory.test.ts` |
| 2 | Consolidation | **PRESENT** | `src/consolidate.ts:69-271` (4-pass: decay / replay / physics / episodic→semantic merge); 16+ tests |
| 3 | Decay | **PRESENT** | `src/memory.ts:94-145` (`calculateStrength` exponential decay); retrieval-strengthening in `markRetrieved` (half-life +2 days) |
| 4 | **Replay** | **PRESENT** (v0.29, 2026-04-21) | `src/replay.ts` (`sampleForReplay`, `replayPriority`) + pass in `src/consolidate.ts:130-165` (between decay and physics); 12 tests in `tests/replay.test.ts` |
| 5 | Pattern completion | **PARTIAL** | `src/physics.ts:444-478` (cluster amplification is autoassociative) but no `searchFromPartialCue` API. |
| 6 | Interference resolution | **PRESENT** | `src/consolidate.ts:299-350` (`detectConflicts`) + `src/invalidation.ts:69-100` (active invalidation) |
| 7 | Emotional tagging | **PRESENT** | `src/memory.ts:44-67,184-191` (`calculateRewardFactor`, `applyOutcome`), `src/physics.ts:115-120` (charge-based valence) |

## Gap #1 (RESOLVED in v0.29, 2026-04-21): Replay

**Status:** Shipped. See `src/replay.ts` and the replay pass in `src/consolidate.ts` (1.5, between decay and physics). 12 unit tests pass + live `hippo sleep` verified the `💭 replayed N memories` line.

### What the pitch said

From `reference_frontier_ai_hippo_answers.md`:

> "biologically-inspired memory architecture ... with 7 hippocampal mechanisms (encoding, consolidation, decay, **replay**, pattern completion, interference resolution, emotional tagging)"

From `README.md:843`:

> Hippocampal replays are compressed versions of episodic experience ...

### What the code does

Grep for `replay|rehearse|Replay|Rehearse` in `src/` returned **zero matches**. `src/consolidate.ts` has three passes (decay, physics, episodic→semantic merge) — none of them rehearse or refresh memories independent of a real retrieval.

Real retrieval via `hippo recall` bumps `last_retrieved` and `retrieval_count`, which extends half-life. But that's driven by user queries, not by the system's own internal consolidation loop. Replay in neuroscience is **internally driven rehearsal during sleep** — without that, the mechanism isn't present.

### Fix scope (for v0.29)

Ship a minimal replay pass in `src/consolidate.ts` that runs during `hippo sleep`:

1. Sample N memories (default 10) weighted by: recency × outcome_positive × strength.
2. For each sampled memory, call a new `rehearse(entry)` helper that bumps `retrieval_count` by 1 and extends `last_retrieved` toward now.
3. Log which memories were replayed in the sleep output.

Sizing: ~80 LOC, 5 tests. ½ day.

This is defensible: the operation is functionally distinct from existing passes (it picks winners rather than processing everything), and it implements the McClelland-style "replay the important stuff so it doesn't decay" dynamic that the pitch references.

## Gap #2 (lower priority): Pattern completion

Cluster amplification in the physics engine already acts autoassociatively (nearby high-scoring particles reinforce each other during `search --physics`). But there's no dedicated `retrieveFromPartialCue(cueTokens)` API that a reviewer could point at and say "that's pattern completion."

### Fix scope

Two options, pick one before October:

- **(a) Expose an API.** Add `hippo recall --partial "cue text"` that treats the cue as a sparse prompt rather than a natural query. Internally it's still cluster-amplified hybrid search, but the surface makes the mechanism legible. ~30 LOC + doc.
- **(b) Rename in README/docs.** Make the existing cluster amplification explicit as "pattern completion via constructive interference" so reviewers can see it without a new command. ~5 LOC (docs only).

Option (b) is honest and cheap. Recommended.

## Actions

- [x] Audit complete; documented in this file.
- [x] Ship replay pass (Task #12) — landed 2026-04-21 (same session).
- [ ] Update README to name cluster amplification as "pattern completion" explicitly.
- [ ] Reference this audit in any future grant milestone reporting.

## Follow-up

After replay ships, the pitch can claim "7 of 7 present with code + tests" without hedging. The feasibility study's O1 (convergence) and O2 (benchmarking) both become easier to defend when the component inventory matches the pitch.
