# 2026-06-09 Lifecycle Stress Eval (first slice) - Result

**Status:** COMPLETED (first measurement). Pre-registration: `docs/evals/2026-06-09-lifecycle-stress-eval-prereg.md`.
**Headline result: a measured NULL (null-to-slightly-negative) on the consolidation-budget hypothesis, plus a clean retrieval-vs-recency win that the lifecycle does NOT contribute to.** Reported straight per the project's honest-reporting + retraction discipline.

## One-paragraph summary

The eval ruler was built and works: it cleanly separates retrieval (hippo) from recency (naive), and it can detect a lifecycle effect when one exists. But the pre-registered HEADLINE hypothesis - that hippo's `sleep` consolidation compresses redundancy so MORE distinct facts survive a fixed active-context budget - does NOT fire on current hippo. The pre-lock dry-run found the mechanistic reason, and it is a property of hippo's consolidation, not a harness artifact: the merge "summary" is a concatenation that is comparable-or-larger than the rows it covers, and it only weakens (does not remove) the source episodics, so consolidation frees no budget. This is a real finding that motivates the roadmap's next major feature (the DAG consolidation hierarchy): the current consolidation is not yet budget-effective, which is exactly the gap the DAG is meant to close.

## The mechanistic root cause (pre-lock dry-run; gate G3)

For a queried fact with a 3-member redundant cluster, after `consolidate()` the top physics-ranked results for the fact's topic, with the PARTICLE MASS that `physicsSearch` actually scores on:

| rank | physicsScore | entry.strength | particle mass | layer | content |
|---|---|---|---|---|---|
| 1 | 1.000 | 0.30 | 1.00 | episodic | "<topic> is <ANSWER>. ..." (so-called weakened original) |
| 2 | 0.94 | 0.30 | 1.00 | episodic | "<topic>, namely <ANSWER>. ..." |
| 3 | 0.936 | 1.00 | 1.00 | semantic | "[Consolidated pattern from 3 related memories] ..." (the summary) |
| 4 | 0.92 | 0.30 | 1.00 | episodic | "<topic> equals <ANSWER>. ..." |

The smoking gun is the **`entry.strength = 0.30` but `particle mass = 1.00`** mismatch. Two compounding reasons consolidation does not help, both verified in source:

1. **The weakening is structurally INERT for retrieval.** `consolidate()` writes `strength = e.strength * 0.3` to the source episodics (`consolidate.ts:506`), but `calculateStrength()` (`memory.ts:292`) - which derives the physics particle mass (`initializeParticle` -> `computeMass(calculateStrength(...))`) AND the recall strength - **never reads the stored `strength` field**; it recomputes strength purely from recency (`last_retrieved`), `half_life_days`, and reward, with an implicit base of 1.0. So a just-merged original (fresh `last_retrieved`) is still scored at mass ~1.0 regardless of the 0.3 written to its `strength` field. Refreshing the physics particles after consolidation (which the harness does) does not change this: the rebuilt mass is still ~1.0. The "weakening" is a field write that the ranking path ignores.
2. **The summary is not a compression.** Even if (1) were fixed, the merge "summary" is a concatenation (k=2: the longest original + a `[Consolidated ...]` prefix; k>=3: bulleted first-lines), comparable-to-larger than its sources, and its boilerplate dilutes its embedding similarity, so it neither displaces the originals on relevance nor shrinks the per-fact footprint.

What DID fire (confirmed in the dry-run): merge clustering on near-duplicate episodics (Jaccard >= 0.35), the answer token surviving into the summary (value-based scoring correctly credits a consolidated answer), and naive-recency missing buried facts while hippo retrieval answers them.

## Harness results (reference run)

`--facts 6 --dupes 3 --checkpoints 1x,10x --seeds 4 --budget 1500`. Read-only physics scoring, hermetic isolated stores, value-based QA, seeded paired bootstrap CI. Two assembly modes: relevance-union (per-fact physicsSearch, repacked to a single global budget B) and strength-sorted (no-query ambient). Deterministic (verified byte-identical across repeat runs). Tests: 9/9 pass.

### 1x (100 memories, naive budget-fit 85.4%; merge fired: ~19.5 episodics -> ~6.8 summaries)

| Condition | QA accuracy | Mean active-context tokens |
|---|---|---|
| naive-append | 50.0% | 1491 |
| recency-window | 100.0% | 1492 |
| hippo-no-lifecycle (relevance) | 100.0% | 1492 |
| hippo-full (relevance) | 100.0% | 1495 |
| hippo-no-lifecycle (strength-sorted) | 100.0% | 1496 |
| hippo-full (strength-sorted) | 100.0% | 1497 |

### 10x (1000 memories, naive budget-fit 9.1%; merge fired: ~89.3 episodics -> ~41.5 summaries)

| Condition | QA accuracy | Mean active-context tokens |
|---|---|---|
| naive-append | 0.0% | 1495 |
| recency-window | 0.0% | 1494 |
| hippo-no-lifecycle (relevance) | 100.0% | 1496 |
| hippo-full (relevance) | 100.0% | 1495 |
| hippo-no-lifecycle (strength-sorted) | 100.0% | 1495 |
| hippo-full (strength-sorted) | 91.7% | 1497 |

Paired QA deltas (95% bootstrap CI, n=4):
- hippo-full vs hippo-no-lifecycle (relevance): **+0.0 pp [0.0, 0.0]** at 1x and 10x.
- hippo-full vs hippo-no-lifecycle (strength-sorted): **+0.0 pp [0.0, 0.0]** at 1x, **-8.3 pp [-16.7, 0.0]** at 10x (null at 1x, slightly NEGATIVE at 10x; CI includes 0).
- hippo-full vs naive-append: +50.0 pp (1x), +100.0 pp (10x) - a RELEVANCE-vs-RECENCY win (hippo-no-lifecycle wins it equally), NOT a lifecycle win.

**QA accuracy is a null (relevance mode, both checkpoints) to slightly NEGATIVE (strength-sorted at 10x) on the lifecycle.** Consolidation never improves which facts are answerable; in the strength-sorted ambient mode at 10x it marginally hurts (-8.3 pp, CI includes 0) because consolidation's summaries (its own, plus the rare merged distractor pair) compete for the fixed budget and a fact summary occasionally loses a slot.

**Token cost: the fixed-budget premise is honored (the per-fact union is repacked to a single budget B), so ALL conditions assemble ~1491-1497 tokens (<= B).** There is no consolidation token advantage. An earlier intermediate run showed an apparent strength-sorted "compression" (a 527-vs-1491 gap); that was an artifact of two bugs the review caught and we fixed: the per-fact union was not repacked to a global budget (so contexts were ~facts x B), and a wall-clock-seeded replay pass plus a tie-unstable strength sort made the number non-deterministic. With those fixed it disappears. Distractor merging (a review finding: distractors shared a template and merged under `consolidate`, contaminating the lifecycle pass) dropped from ~100% of the store to ~9% after the injector fix, and it does not affect the value-based QA metric.

## Interpretation

- The ruler is built and discriminates (it cleanly separates retrieval from recency, and would detect a lifecycle effect if one existed). The first reading is an HONEST NULL on the consolidation-budget headline, robust across both assembly modes and deterministic.
- Retrieval is not the bottleneck at this scale: hippo retrieval (with or without the lifecycle) answers buried facts that recency misses. The hippo-vs-naive win is retrieval, not lifecycle.
- The current `sleep` consolidation cannot make retrieval more budget-efficient, for two compounding reasons both verified in source. FIRST, its strength-weakening is INERT: `consolidate()` writes `strength x0.3` to merged source episodics, but `calculateStrength()` (which drives physics mass AND recall strength) ignores the stored `strength` field and recomputes from `last_retrieved`/`half_life`, so the originals keep mass ~1.0 and are never demoted. SECOND, the merge summary is a concatenation (>= the size of its sources) whose boilerplate dilutes its embedding, so it neither outranks the originals nor shrinks the footprint. Net: null in relevance, null-to-slightly-negative in ambient at <=10x.
- This is the concrete gap the DAG consolidation hierarchy (ROADMAP.md Part III, the "next major feature") needs to close: a consolidation that produces genuinely SMALLER summaries which DISPLACE (not merely weaken) their children, and that rank well under both relevance and strength assembly. The ruler now exists to measure whether the DAG actually delivers that, against a pre-registered bar.

## Follow-ups (logged)

1. **hippo (likely bug): consolidation's strength-weakening is a no-op for retrieval.** `consolidate()` writes `strength x0.3` to merged source episodics (`consolidate.ts:506`) to signal demotion, but `calculateStrength()` (`memory.ts:292`) - the canonical strength used for physics mass and recall - does not read the stored `strength` field; it recomputes from `last_retrieved`/`half_life`. So the weakening never affects ranking (verified: a merged original shows `entry.strength=0.30` but `particle mass=1.00`). Either `calculateStrength` should factor the stored strength, or `consolidate` should demote via the fields the strength function actually uses. Worth a hippo issue independent of the eval, and a prerequisite for any budget-effective consolidation.
2. **hippo: the merge summary is not a true compression** (concatenation, >= the size of its sources). For consolidation to free budget the summary must be genuinely smaller AND displace its children. This is the motivation for the DAG consolidation hierarchy.
3. **Frontier-1M-context baseline** (deferred this slice; needs API egress).
4. **Supersession axis** (secondary; within-hippo op-on-vs-off ablation): `getContext` hard-excludes superseded rows, so it is expected to reduce stale-answer rate; measure in the next slice with evolving-fact injection (the harness already carries an empty `staleTokens` hook for it).
5. **Scale to the 100x / 20-seed pre-registered primary cell** once a consolidation change makes the headline worth re-measuring; this slice is a 1x/10x, 4-seed smoke.
6. **Residual distractor merge (codex P2, accepted for this slice):** sampling 7 words from a 60-word pool lets some distractor pairs share >=5 words (Jaccard ~0.45 > the 0.35 merge threshold), so ~41 distractor summaries form at 10x. This does NOT affect the value-based QA headline (distractors carry no fact answer tokens, so QA-by-value is clean); it only adds noise summaries to the strength-sorted SECONDARY axis (already caveated, CI includes 0). Before the 100x/20-seed primary run, widen the vocabulary (~3x) or add a pairwise-overlap cap so distractor merges go to ~0.

## Reproduce

```
cd <repo> && npm run build
node scripts/lifecycle-stress/probe.mjs            # the mechanistic dry-run (G2/G3/G4)
node scripts/lifecycle-stress/run.mjs --facts 6 --dupes 3 --checkpoints 1x,10x --seeds 4 --budget 1500
npx vitest run tests/lifecycle-stress.test.ts
```
