# 2026-05-25 — DAG live-coupling E4: first-class DAG recall (scoring layer)

**Status:** Draft v3.1 (R3 PASS score 9 — 1 MED + 2 LOW polish folded; sync searchBoth verified ZERO src callers via grep)
**Episode:** 01KSGEHS9P26XRB86RHP7JJCGN
**Branch:** feat-dag-e4-recall (off feat-dag-e3-rebuild-summaries; stacked PR — do NOT --delete-branch E3 on merge)
**Owner:** Claude (Keith review)

## Discover refinement (hoisted per "Discover IS a scope-decision stage" memory)

Brainstorm framing: "DAG nodes first-class in hybridSearch + physicsSearch with summaryDeboost".

**Critical R1 finding — api.recall() does NOT route through hybridSearch.** `api.recall` at `api.ts:413` uses `loadRecallSearchEntries` (SQL BM25 ordering) + positional placeholder scores at L509-513 (`Math.max(0, 1 - idx / Math.max(1, limit))`). The existing substitution path at L535-568 runs against those raw entries, NOT against hybridSearch composite scores. This is the primary MCP/HTTP recall surface. E4's deboost will NOT fire there.

E4 is therefore rescoped honestly: **the scoring-layer surfaces** (hybridSearch + physicsSearch + synchronous search) reached by these callers:
- `api.context()` at `api.ts:1819+` (calls `searchBothHybrid` → physicsSearch/hybridSearch)
- `cli.cmdRecall` / `cmdContext` at `cli.ts:925, 1465` (call `searchBothHybrid`)
- `eval.ts:137` (calls `searchBothHybrid`)
- `shared.searchBoth` / `searchBothHybrid` (merge two hippoRoots) — propagates deboost via underlying call
- Any direct caller of `hybridSearch` / `physicsSearch` / synchronous `search()`

**Explicit OOS — api.recall() integration**: threading hybridSearch into api.recall would require redesigning the substitution path (currently positional-order dependent) + risk-managing breaking changes to the primary MCP/HTTP surface. Out of E4 scope — surfaces as required follow-up PR ("E4.5 — api.recall hybridSearch integration") to be planned separately. E4 ships the scoring primitive; E4.5 wires it everywhere.

Existing DAG-recall foundation (per `docs/plans/2026-05-05-dag-recall.md`) is ALREADY SHIPPED:
- Task 1: cached metadata (descendant_count + earliest/latest_at). ✓
- Task 2: budget-aware summary substitution. ✓ (runs in api.recall, untouched by E4)
- Task 3: drillDown API + MCP + HTTP. ✓
- Existing drill-down injection in search at L506-529 (async) + L923-946 (sync): when a summary tag matches, children injected at `parent_score * 0.9`. The 0.9 is NOT a deboost — it's child-injection ratio. Untouched by E4.

Pre-verified per E3 retro lessons:
- `SearchResult` (L169) and `ScoreBreakdown` (L184) are exported.
- `estimateTokens` (L107) and `temporalBoost` (L149) are exported.
- Internal helpers `scopeMatch`, `recencyBoost`, `extractPathTags`, `pathOverlapScore`, `computePhysicsScores` are private to `search.ts` — fine, all new code lives in `search.ts`.
- `breakdown` consumed by `src/cli.ts:1485-1559` (explain JSON + renderer) + `src/shared.ts:110-114,188-192` (searchBoth merge — spreads breakdown, overwrites `final` + `sourceBump`). Adding OPTIONAL fields is backward-compatible (spread preserves; renderer ignores unknown fields).
- `physicsSearch` (L651) has TWO paths needing deboost:
  - Physics-particle scoring loop at L731-748
  - Classic-entry fallback to `hybridSearch` at L685/689/693/707 — already passes `options` spread so deboost option propagates automatically (verified in S4 below).
- Synchronous `search()` at L821 — **R2 HIGH must-fix DROPPED FROM SCOPE**. search()'s options shape lacks `explain` and breakdown plumbing entirely (L824 inline type + L866-901 scoring loop). Adding both = separate refactor of larger surface area. E4 deboost lands in async path only; sync search() flagged as standalone follow-up.
- `shared.searchBothHybrid` at L164-205 — **R2 HIGH must-fix FOLDED**. Critic verified L170-182: options are EXPLICITLY ENUMERATED (not spread). `summaryDeboost`/`summaryFreshness` will be silently dropped without explicit pass-through. S6 below adds the field forwarding + extends `HybridSearchOptions` interface at L144-158.
- Snapshot risk pre-checked (R1 LOW): `tests/cli-context-render-snapshot.test.ts` does NOT use `explain:true` (grep -c returned 0) and the .snap file has NO dag_level/dag-summary references (grep -c returned 0). Snapshot risk is NIL for E4.

Carry-forward concerns (each addressed):

1. **Backward compat — breakdown optional fields**: all 6 new fields `?:`; consumers in cli.ts + shared.ts unchanged (additive only).
2. **Test snapshots**: search-related snapshots updated only if drift. `tests/cli-context-render-snapshot.test.ts` already on watchlist from E2/E3.
3. **Existing drill-down 0.9 ratio**: NOT touched. summaryDeboost is orthogonal (scales summary itself).
4. **Deboost vs freshness ordering**: deboost first (universal L2 scaling), freshness second (gentle nudge for fresh). Both visible separately in breakdown.
5. **Env var contract**: `HIPPO_SUMMARY_DEBOOST` parses float; out-of-range (≤0, >1, NaN) falls back to 0.85. Per-call option overrides env. Tests use explicit `beforeEach` save / `afterEach` restore (S7 spec).
6. **Substitution interaction (CORRECTED from v1)**: substitution path in `api.recall` operates on raw BM25 entries, deboost operates on hybridSearch/physicsSearch composite scores — **DIFFERENT code paths**. They do not compose; they also do not conflict. Substitution untouched by E4.
7. **R1 HIGH MMR + reranker interactions**: tested explicitly (S7 tests #13 + #14). MMR uses post-deboost relevance score → deboost shifts summary down in MMR diversity selection. Reranker receives post-deboost ordered slice → reranker may re-sort and undo intent. Both behaviors locked by test.
8. **R1 MED dag_level=2 vs 'dag-summary' tag mismatch**: SHIPS WITH SINGLE PREDICATE. Introduce `isDagSummary(entry)` helper at module scope that checks `entry.dag_level === 2` (the structural truth). Existing drill-down at L508/L925 currently uses tag check — DO NOT modify existing drill-down in this PR (separate refactor — flagged as known follow-up). Plan code uses `isDagSummary` everywhere in NEW code paths so the new deboost predicate is self-consistent.
9. **R1 MED synchronous search() folded**: see S6. Same deboost + breakdown enrichment as hybridSearch.

## Why this exists

E4 of 5-episode DAG live-coupling arc. E1 (PR #66) shipped schema. E2 (PR #67) shipped child-write hooks. E3 (PR #68) shipped sleep-cycle rebuild (last_rebuilt_at, rebuild_count populated). E4 makes the live-coupled DAG **observable + balanced in the scoring layer**.

Without E4: rebuilt summaries are invisibly indistinguishable from stale ones in search results, and a query matching a topic-summary monopolizes the budget in `api.context()` / CLI recall / eval.

## Goal

Three additive backward-compatible changes:

1. **summaryDeboost multiplier** on L2 summary scores in `hybridSearch`, `physicsSearch` (physics-particle loop), and synchronous `search()`. Default 0.85. Tunable via `HIPPO_SUMMARY_DEBOOST` env + per-call option.
2. **Freshness micro-boost** (1.05 if `last_rebuilt_at` within 7 days). Consumes E3's column. Default on, opt-out via `summaryFreshness: false`.
3. **Six optional ScoreBreakdown fields** populated when `explain=true`: `dagLevel`, `descendantCount`, `lastRebuiltAt`, `rebuildCount`, `summaryDeboost`, `summaryFreshnessBoost`.

## Scope

### S1 — Extend `ScoreBreakdown` interface in `src/search.ts`

Add 6 optional fields at end (positional readers unaffected):

```typescript
export interface ScoreBreakdown {
  // ... existing fields unchanged ...

  /** v0.30 / E4 — entry.dag_level (0=raw, 1=extracted, 2=topic, 3=entity). */
  dagLevel?: number;
  /** v0.30 / E4 — descendant_count column (refreshed by E3 rebuild). */
  descendantCount?: number;
  /** v0.30 / E4 — last_rebuilt_at ISO; null if never rebuilt. L2 only. */
  lastRebuiltAt?: string | null;
  /** v0.30 / E4 — cumulative rebuild_count from E3. L2 only. */
  rebuildCount?: number;
  /** v0.30 / E4 — deboost applied (1.0 for non-summaries). */
  summaryDeboost?: number;
  /** v0.30 / E4 — 1.05 if L2 + rebuilt within 7 days; 1.0 otherwise. */
  summaryFreshnessBoost?: number;
}
```

### S2 — Add module-scope helpers in `src/search.ts`

```typescript
const DEFAULT_SUMMARY_DEBOOST = 0.85;
const DEFAULT_FRESHNESS_BOOST = 1.05;
const FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** v0.30 / E4 — single source of truth for "is this a DAG L2 summary".
 *  R1 MED: existing drill-down uses tag check ('dag-summary'); structural
 *  truth is dag_level === 2. New code in E4 uses this helper; existing
 *  drill-down NOT modified (separate refactor flagged as follow-up). */
export function isDagSummary(entry: MemoryEntry): boolean {
  return entry.dag_level === 2;
}

function resolveSummaryDeboost(perCall?: number): number {
  if (perCall !== undefined && Number.isFinite(perCall) && perCall > 0 && perCall <= 1) {
    return perCall;
  }
  const raw = process.env.HIPPO_SUMMARY_DEBOOST;
  if (raw !== undefined) {
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) {
      return parsed;
    }
  }
  return DEFAULT_SUMMARY_DEBOOST;
}

/** v0.30 / E4 — micro-boost for L2 summaries rebuilt within the window.
 *  Handles null + invalid date strings via Number.isFinite gate. */
function summaryFreshnessMultiplier(entry: MemoryEntry, now: Date): number {
  if (!isDagSummary(entry) || !entry.last_rebuilt_at) return 1.0;
  const rebuiltMs = new Date(entry.last_rebuilt_at).getTime();
  if (!Number.isFinite(rebuiltMs)) return 1.0; // garbage string → 1.0
  const ageMs = now.getTime() - rebuiltMs;
  return ageMs >= 0 && ageMs <= FRESHNESS_WINDOW_MS ? DEFAULT_FRESHNESS_BOOST : 1.0;
}
```

### S3 — Extend `hybridSearch` options + scoring loop

Add 2 options at L243:
```typescript
summaryDeboost?: number;
summaryFreshness?: boolean;
```

Resolve at top:
```typescript
const summaryDeboost = resolveSummaryDeboost(options.summaryDeboost);
const summaryFreshness = options.summaryFreshness ?? true;
```

In the scoring for-loop at L380, AFTER existing `extractionBoost` / `temporalBoost` block (around L438), BEFORE the `if (compositeScore <= 0) continue;` check at L440:

```typescript
// v0.30 / E4 — DAG L2 summary deboost + freshness micro-boost.
// Applied last in the multiplier chain so it composes with all other boosts.
let summaryDeboostMultiplier = 1.0;
let freshnessMultiplier = 1.0;
if (isDagSummary(entries[i])) {
  summaryDeboostMultiplier = summaryDeboost;
  if (summaryFreshness) {
    freshnessMultiplier = summaryFreshnessMultiplier(entries[i], now);
  }
}
compositeScore *= summaryDeboostMultiplier * freshnessMultiplier;
```

In `explain` block at L459-476, populate new optional fields:

```typescript
if (entries[i].dag_level !== undefined) {
  result.breakdown.dagLevel = entries[i].dag_level;
}
if (entries[i].descendant_count !== undefined) {
  result.breakdown.descendantCount = entries[i].descendant_count;
}
if (isDagSummary(entries[i])) {
  result.breakdown.lastRebuiltAt = entries[i].last_rebuilt_at ?? null;
  result.breakdown.rebuildCount = entries[i].rebuild_count ?? 0;
  result.breakdown.summaryDeboost = summaryDeboostMultiplier;
  result.breakdown.summaryFreshnessBoost = freshnessMultiplier;
}
```

### S4 — Extend `physicsSearch` options + physics-particle loop

Add same 2 options at L653 (`summaryDeboost?: number; summaryFreshness?: boolean;`).

Resolve at top (same helpers as hybridSearch).

In physics-particle scoring loop at L731-748, after `s.finalScore` is read and `entry` is fetched, apply deboost to the score that lands in `physicsResults`:

```typescript
// v0.30 / E4 — apply same deboost + freshness in physics-particle path.
let summaryDeboostMultiplier = 1.0;
let freshnessMultiplier = 1.0;
if (isDagSummary(entry)) {
  summaryDeboostMultiplier = summaryDeboost;
  if (summaryFreshness) {
    freshnessMultiplier = summaryFreshnessMultiplier(entry, now);
  }
}
const finalScore = s.finalScore * summaryDeboostMultiplier * freshnessMultiplier;
// ... use finalScore in result construction; populate breakdown if explain ...
```

Populate same breakdown fields when `explain=true`.

**Note on physicsSearch's hybridSearch fallback** (L685/689/693/707): existing code already passes `options` as the third arg, which spreads to include `summaryDeboost` + `summaryFreshness` once added to physicsSearch options. No separate change needed. (Test #11 verifies this end-to-end.)

### S5 — Synchronous `search()` path — DEFERRED to follow-up

R2 HIGH must-fix outcome: sync `search()` options at L824 lack `explain` and the scoring loop at L866-901 has no breakdown plumbing. Adding both = larger refactor. Drop from E4 scope.

`shared.searchBoth` (sync) at L102-103 calls `search(query, entries, { budget, now, minResults })` — does not forward deboost. Acceptable for E4 since the sync path is legacy + has no real-world async-DAG callers (verify in execute via grep).

### S6 — `shared.ts` pass-through for `searchBothHybrid` (R2 HIGH must-fix)

`HybridSearchOptions` at `shared.ts:144-158` gains:
```typescript
/** v0.30 / E4 — propagated to hybridSearch underlying calls. */
summaryDeboost?: number;
summaryFreshness?: boolean;
```

`searchBothHybrid` at L170 destructure adds `summaryDeboost, summaryFreshness`:
```typescript
const { budget = 4000, now = new Date(), embeddingWeight, explain, mmr, mmrLambda, localBump = 1.2, minResults, scope, includeSuperseded, asOf, tenantId, summaryDeboost, summaryFreshness } = options;
```

L177-182 both hybridSearch calls add the two new fields:
```typescript
const localResults = await hybridSearch(query, localEntries, {
  budget, now, hippoRoot: localRoot, embeddingWeight, explain, mmr, mmrLambda, minResults, scope, includeSuperseded, asOf, summaryDeboost, summaryFreshness,
});
const globalResults = await hybridSearch(query, globalEntries, {
  budget, now, hippoRoot: globalRoot, embeddingWeight, explain, mmr, mmrLambda, minResults, scope, includeSuperseded, asOf, summaryDeboost, summaryFreshness,
});
```

`searchBoth` (sync) is NOT modified — its options shape doesn't carry deboost (since sync search() doesn't either). **Verified via `grep searchBoth\\( src/`: ZERO src callers**, so sync path is truly legacy + dead. OOS is safe.

**Note on R2 MED D4 (final/sourceBump composition)**: shared.ts L190-192 does `{ ...r.breakdown, sourceBump: localBump, final: r.breakdown.final * localBump }`. The spread preserves `summaryDeboost` field (new optional). After composition: `final = (composite * 0.85 * freshness) * 1.2` and `summaryDeboost` field shows 0.85 separately. Composition is verifiable: `final / sourceBump / summaryDeboost / freshness = base * other-multipliers`. Test #16 locks this invariant.

### S7 — Tests in `tests/dag-recall-first-class.test.ts`

16 cases, all real-DB. Explicit env save/restore in `beforeEach`/`afterEach` (R1 LOW must-fix):

```typescript
let savedDeboost: string | undefined;
beforeEach(() => { savedDeboost = process.env.HIPPO_SUMMARY_DEBOOST; });
afterEach(() => {
  if (savedDeboost !== undefined) process.env.HIPPO_SUMMARY_DEBOOST = savedDeboost;
  else delete process.env.HIPPO_SUMMARY_DEBOOST;
});
```

Cases:
1. **Default deboost applied** to L2 summary, not to L1 fact.
2. **Per-call summaryDeboost=1.0 disables**.
3. **Env `HIPPO_SUMMARY_DEBOOST=0.5`** respected (resolved 0.5 in breakdown).
4. **Env out-of-range** (2.0, 0.0, NaN) → fallback 0.85.
5. **Per-call option overrides env**.
6. **Freshness boost** when last_rebuilt_at < 7 days → 1.05 in breakdown.
7. **No freshness** when last_rebuilt_at null → 1.0.
8. **No freshness** when last_rebuilt_at > 7 days → 1.0.
9. **No freshness** when last_rebuilt_at = garbage string → 1.0 (R1 MED must-fix).
10. **Deboost + freshness compose** for fresh summary → 0.85 * 1.05 = 0.8925x.
11. **physicsSearch applies deboost** end-to-end (seed physics state for a L2 summary with PhysicsParticle position + velocity matching query dim — see fixture in S7 below).
12. **Explain mode breakdown populated** for L2 entry with all 6 fields.
13. **MMR-on with deboost on** (R1 HIGH must-fix). Setup: 1 summary + 4 distinct facts, embeddings loaded, mmr=true, mmrLambda=0.5. Assert deboost SHIFTS summary's rank vs deboost=1.0 baseline. Document observed behavior (no specific score assertion; rank-shift assertion).
14. **Reranker-on with deboost on** (R1 HIGH + R2 MED must-fix). Mock reranker that **records its input**. Assert: (a) the reranker's input contains the L2 summary with score = composite * 0.85 (the post-deboost composite), (b) reranker's final output is the reranker's prerogative (not asserted further). Test name: "deboost survives until reranker; reranker decides final order". Documents design intent.
15. **(removed — sync search() out of scope)**
16. **shared.searchBothHybrid pass-through** (R2 HIGH must-fix). Setup: a L2 summary in localRoot WITH `last_rebuilt_at = null` (R3 LOW: avoids freshness factor in expected formula). Call `searchBothHybrid(query, localRoot, globalRoot, { explain: true })` with no summaryDeboost option (uses default 0.85). Assert: result has `breakdown.summaryDeboost === 0.85` AND `breakdown.sourceBump === 1.2` AND `breakdown.summaryFreshnessBoost === 1.0` AND `breakdown.final ≈ base * 0.85 * 1.0 * 1.2`. Locks the D4 composition invariant.
17. **physicsSearch hybridSearch-fallback inherits deboost** (R3 MED). Setup: L2 summary in store, NO physics state seeded for it (no PhysicsParticle), NO embedding available (force fallback). Call `physicsSearch(query, entries, { explain: true })`. Inside physicsSearch this falls through to `hybridSearch(query, entries, options)` at L685/689/693/707. Assert: result `breakdown.summaryDeboost === 0.85` (deboost propagated via options spread). Locks the AC5 inheritance chain that test #11 doesn't exercise.

**Physics-particle test #11 fixture spec** (R2 LOW fix: table is `memory_physics` not `physics_state`; use the helper API not raw SQL): open db, write L2 summary entry, construct a `PhysicsParticle` with `position` + `velocity` arrays sized to match `queryEmbedding`, call `savePhysicsState(db, [particle])` (avoids hand-rolling float32-to-buffer). Pass `queryEmbedding` directly via `options.queryEmbedding` so the test doesn't depend on embedding service. This forces the L2 summary into the physics-particle scoring path (not the classic fallback). Verify breakdown.summaryDeboost is populated in the result.

### S8 — Scope boundary

NOT in E4:
- `api.recall()` integration (E4.5 follow-up — refactor api.recall to use hybridSearch + reconcile substitution path)
- **Synchronous `search()` deboost + breakdown plumbing** (R2 HIGH outcome: deferred to standalone refactor)
- `shared.searchBoth` (sync sibling of searchBothHybrid) — same reason
- Level-3 entity profiles (E5)
- Existing drill-down 0.9 child-injection ratio — untouched (separate refactor flagged below)
- Existing dag-summary tag vs dag_level=2 reconciliation in drill-down — flagged as follow-up; E4 uses `isDagSummary` only in NEW code paths
- CLI `--summary-deboost` flag (env + option sufficient)
- HTTP /v1/recall response shape changes (additive breakdown passes through naturally)

## Acceptance criteria

1. AC1: `summaryDeboost` resolves precedence: per-call > env > 0.85 default. Out-of-range falls back to 0.85 at any level.
2. AC2: Default deboost (0.85) applied to L2 summaries in hybridSearch AND physicsSearch (physics-particle path). Synchronous search() OOS.
3. AC3: `isDagSummary(entry)` (dag_level === 2) is the single predicate in all NEW code paths.
4. AC4: Freshness multiplier: 1.05 if `last_rebuilt_at` within 7 days; 1.0 if null, ≥7 days, or garbage string.
5. AC5: physicsSearch hybridSearch-fallback at L685/689/693/707 inherits deboost via existing `options` spread. Locked by test #17.
6. AC6: `ScoreBreakdown` gains 6 OPTIONAL fields. Existing consumers in cli.ts + shared.ts unchanged.
7. AC7: When `explain=true`, breakdown populated for L2 entries (all 6 fields), L0/L1 entries (dagLevel + descendantCount only if set).
8. AC8: Existing drill-down 0.9 ratio at search.ts:518/935 NOT touched.
9. AC9: Existing substitution path in api.recall (api.ts:535) untouched. dag-recall-substitution.test.ts passes unchanged.
10. AC10: MMR-on with deboost on — observed behavior locked by test #13 (rank-shift documented).
11. AC11: Reranker-on with deboost on — reranker INPUT confirmed post-deboost; output is reranker's prerogative.
12. AC12: **shared.searchBothHybrid forwards summaryDeboost + summaryFreshness** to underlying hybridSearch calls. HybridSearchOptions extended.
13. AC13: All 16 tests pass (test #15 removed — sync search OOS; +1 added as #17 for AC5 inheritance lock).
14. AC14: No regression — full test suite green.
15. AC15: api.recall() integration EXPLICITLY out-of-scope; E4.5 follow-up documented.
16. AC16: shared.searchBothHybrid composition invariant: `breakdown.final / breakdown.sourceBump = composite * summaryDeboost * summaryFreshnessBoost` (test #16 locks).

## Risks

1. **R1 (RESOLVED in v3)**: snapshot risk pre-checked NIL via grep (no explain mode + no dag_level in cli-context-render-snapshot.test.ts).
2. **R2 (MED)**: cli renderer at cli.ts:1536-1559 won't render the 6 new fields visually (--explain text mode). `--explain --json` shape test in S7 #12 covers JSON consumers. Visual rendering left for follow-up.
3. **R3 (LOW)**: default deboost is a behavior change. Existing tests asserting specific L2 summary scores MAY break. Mitigation: search execute stage; pass `summaryDeboost: 1.0` for back-compat where required.
4. **R4 (LOW)**: freshness boost ON by default. Same mitigation as R3.
5. **R5 (LOW)**: env-var leak between tests handled by explicit save/restore pattern (S7 setup).
6. **R6 (LOW)**: per-entry `new Date(entry.last_rebuilt_at)` allocation. Acceptable at ≤100 summaries per query. Hoisting deferred.
7. **R7 (LOW — NEW)**: `api.recall()` users won't see deboost benefit. Documented as E4.5 follow-up. Lower bar than HIGH since `api.context()` (the merged context-window assembler) IS covered, and that's where DAG-aware recall most matters.
8. **R8 (LOW — NEW)**: dag-summary tag vs dag_level=2 predicate mismatch in existing drill-down. NEW code uses `isDagSummary` (structural); existing tag-based drill-down at L508/L925 untouched in E4. Follow-up reconciliation flagged.

## Out of scope (deferred)

- **E4.5 follow-up**: api.recall() refactor to use hybridSearch + reconcile with positional-order substitution
- E5 level-3 entity profiles
- Drill-down 0.9 ratio reconsideration
- isDagSummary unification across existing drill-down (separate refactor)
- CLI text-mode renderer for new breakdown fields (JSON shape covered)
- CLI `--summary-deboost` flag (env + option sufficient)
- Tuning defaults (0.85 / 1.05 / 7 days) based on benchmark data — defer to eval pass

## Ship pattern

Stacked PR off `feat-dag-e3-rebuild-summaries`. PR #69 expected. Per gh-cascade memory: plain `gh pr merge 68 --rebase` on E3 merge (NO --delete-branch).

Title (E3 retro lesson — ≤70 chars, drop arc suffix): `feat(search): E4 DAG-aware scoring deboost + breakdown` (54 chars).
PR body: no em dashes (E3 retro lesson).

No publish at end of E4 — bundled at end of E5 per Keith's "one bundled release v1.12.12" pick.
