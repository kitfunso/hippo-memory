# 2026-05-25 / DAG live-coupling E5: level-3 entity profiles + drillDown depth

**Status:** Draft v3 (R2 PASS score 8 / 4 must_fix folded: S5 eligible.length code-bug, SELECT-before-UPDATE perf via RETURNING clause, audit metadata line anchors, cmdDrillDown rename + client-side depth clamps)
**Episode:** 01KSGH3FFBEN9WGV19CNJJZQTV
**Branch:** feat-dag-e5-entity-profiles (off feat-dag-e4-recall; stacked PR, do NOT --delete-branch E4 on merge)
**Owner:** Claude (Keith review)

## Discover refinement (hoisted per "Discover IS a scope-decision stage" memory)

Brainstorm framing: "level-3 entity profiles + drillDown --depth N".

E3+E4 retro lessons applied during discover (pre-verified before plan-write):

1. **All 5 SQL guards filtering `dag_level = 2` enumerated**: store.ts:2524 (markSummaryDirtyInTx), :2561 (markSummaryDirty), :2690 + :2700 (applyRebuildResult bumpRebuildCount true/false branches), :2799 (clearSummaryDirtyAfterBuild). E5 widens all 5 to `IN (2, 3)`. The E1/E2 comments explicitly anticipated this: store.ts:2541 says "E5 will widen the dag_level guard to IN (2, 3) when level-3 build path lands".

2. **3 api.ts sites pin to dag_level=2 in the overflow substitution path** (R1 LOW L4 enumeration): api.ts:542 (`if ((e.dag_level ?? 0) > 1) continue;` filters L1+L0 candidates), api.ts:553 (`(p) => (p.dag_level ?? 0) === 2` filters eligible parents to L2 only), api.ts:883 (recall-time scope filter that also pins L2). **All three explicitly OUT OF SCOPE for E5** — L3 substitution in api.recall overflow is a separate refactor. Do NOT widen these.

3. **dag_level_3_built_at column already exists in schema v28** (db.ts:968-971, MemoryEntry.dag_level_3_built_at at memory.ts:94, MEMORY_SELECT_COLUMNS at store.ts:199). No schema migration needed. Populated at L3 creation time; NOT bumped on rebuild.

4. **drillDown signature** at api.ts:1018, DrillDownOpts has `limit` + `budget`. E5 adds `depth?: number` (default 1, preserves backward compat).

5. **drillDown call sites traced**: cli.ts:4537 (`cmdDrill`), server.ts:643 (HTTP /v1/drill), mcp/server.ts (via apiDrillDown import). Each needs `--depth` / `depth` pass-through.

6. **AuditOp lockstep verified**: `summary_marked_dirty` + `summary_rebuilt` + `summary_marked_clean` already in union (audit.ts:142-144) + cli.ts VALID_AUDIT_OPS (4738-4740) + server.ts VALID_AUDIT_OPS (83-85). **No new ops for E5**; E5 only widens existing emitters' WHERE clauses + extends metadata semantics.

7. **rebuildDirtySummaries already generic over level**: loadChildrenOfSummary at store.ts:2620 walks by `dag_parent_id`, level-agnostic. applyRebuildResult's UPDATE filters `dag_level = 2`, which becomes IN (2, 3). generateDagSummary takes `(label, factContents, opts)` — for L3, the "facts" are L2 summary contents. Reusable as-is.

8. **buildEntityProfiles mirrors buildDag**: cluster L2 by shared entity tag (speaker:X, topic:X) using same `clusterFacts` helper from dag.ts:10, threshold 2+ L2s per entity, generate via generateDagSummary, set dag_level=3 + dag_parent_id=null + dag_level_3_built_at=now + descendant_count + earliest/latest_at. Then link the L2 children with dag_parent_id pointing to new L3, then `clearSummaryDirtyAfterBuild` on the new L3 (born-dirty cancellation, E3 retro lesson).

9. **E4 deboost: extend isDagSummary to L3** — current `isDagSummary(entry)` returns `dag_level === 2`. E5 widens to `dag_level === 2 || dag_level === 3`. Same 0.85 deboost applies. Differentiated deboost (e.g. 0.7 for L3) flagged as follow-up, not E5 scope.

10. **H1 FOLD: existing tests that hardcode `dag_level: 2` in audit metadata assertions**: `tests/dag-dirty-flag-schema.test.ts:165` does `expect(events[0]!.metadata).toMatchObject({ dag_level: 2, source: 'E1' });`. With the widened predicate, the L2 case still emits `dag_level: 2` (the actual level read at audit time, NOT a hardcoded constant), so this test continues to pass unchanged. The L3 case emits `dag_level: 3` — exercised by new E5 tests. Plan v2 reads the actual level pre-UPDATE (via SELECT or caller pass-through) so audit metadata stays accurate. Existing tests:
   - `dag-dirty-flag-schema.test.ts:165` — unchanged (L2 → 2 still correct)
   - `dag-dirty-flag-schema.test.ts:102` test name "markSummaryDirty no-ops on non-summary rows (dag_level !== 2)" — RENAME to "(dag_level NOT IN (2, 3))" since the predicate widens
   - `dag-recall-first-class.test.ts:315` `isDagSummary({dag_level: 1}) === false` — unchanged (L1 still false); add `isDagSummary({dag_level: 3}) === true` as a new case in this test or a new E5 test
   - No other tests pin `dag_level: 2` in metadata.

11. **H2 FOLD: phase 1.9 data source**: `survivors` (consolidate.ts:139) is built from the decay-pass output. buildDag (phase 1.7) writes new L2 summaries directly via `writeEntry` without pushing them back into `survivors`. So `survivors` does NOT contain the just-created L2s at phase 1.9 time. R1 H2 must-fix: phase 1.9 MUST re-load from disk. Two options:
    - (a) `loadAllEntries(hippoRoot)` second-call (already done at L121 for main pass). Memory cost: full table re-load. On large stores this is real.
    - (b) Add `loadAllL2Summaries(hippoRoot)` tenant-host-wide helper that filters at SQL (`WHERE dag_level = 2 AND dag_parent_id IS NULL AND kind != 'archived'`).
    
    **Plan v2 picks (b)** — aligns with the loadAllDirtySummaries pattern (E3), cheaper, single-purpose. Adds ~25 lines to store.ts.

Carry-forward concerns (each addressed):

1. **Phase ordering**: consolidate runs 1.7 buildDag → 1.8 rebuildDirtySummaries → **1.9 buildEntityProfiles** (NEW). L3 build reads fresh L2 content via `loadAllL2Summaries` (NOT `survivors`).

2. **Born-dirty cancellation on L3**: same dance as buildDag at L161 (E3). `buildEntityProfiles` calls `clearSummaryDirtyAfterBuild` on each newly-created L3 after its L2 children link loop. M3 FOLD: `clearSummaryDirtyAfterBuild` gains a `source?: string` param (default 'buildDag-clean'). buildEntityProfiles passes `source='buildEntityProfiles-clean'` for distinguishability.

3. **drillDown depth>1 budget semantics**: GLOBAL cumulative budget across all levels (NOT per-level). Same `Math.ceil(content.length / 4)` cost per child. Truncation flag set on first level that hits the cap.

4. **Cycle prevention + dedup in drillDown depth walk** (M1 FOLD): DAG is acyclic by construction (no back-edges), BUT `dag_parent_id` has no uniqueness constraint, so two L2s sharing an L1 child (data anomaly) would double-emit at depth>1. BFS gets `visited: Set<string>` to dedup. Test #8 asserts "all returned ids unique".

5. **Audit ops**: no new ops. `summary_rebuilt` source='E3-rebuild' fires for L2 + L3 rebuilds uniformly. `summary_marked_dirty` source='E2' fires for L2 + L3 dirty marks. `summary_marked_clean` source='buildDag-clean' or 'buildEntityProfiles-clean' via new source param.

6. **Multi-tenant isolation**: existing isolation pattern preserved. `loadAllDirtySummaries` and new `loadAllL2Summaries` are host-wide loaders that return entries with tenantId attached; per-summary children query stays tenant-scoped via summary.tenantId. drillDown depth-walk uses ctx.tenantId at each level (loadChildrenOf is tenant-scoped).

7. **totalChildren vs descendantCount semantics** (M5 FOLD): with depth>1, returned `totalChildren = collected.length` (sum across all visited levels), while `summary.descendantCount` stays as the summary's stored direct-child count. Plan documents this explicitly + test #8 asserts both numbers separately so the contract is unambiguous.

8. **Phase 1.9 vs 1.7 asymmetry** (M4 FOLD): phase 1.9 runs even when phase 1.7 was skipped (no extracted facts that cycle). Intentional — E5 should re-cluster existing L2s into L3s on every sleep regardless of new extraction. The phase 1.9 guard `if (l2Summaries.length >= 2)` handles the empty-store case.

9. **cmdDag tree view extension** (L1 FOLD, promoted to MED): cli.ts:4479 (cmdDag tree mode) currently filters `entries.filter((e) => e.dag_level === 2)`. After E5, L3 entity profiles would render nowhere in `hippo dag` tree. R1 LOW L1 promoted to MED. Plan v2 S9 (NEW) extends cmdDag to render a two-level tree: L3 → L2 → (optional L1 leaves). UX gap closed.

## Why this exists

Final episode of 5-episode DAG live-coupling arc. E1-E4 built the L2 layer with live-coupled rebuild + first-class scoring. E5 lifts to L3: entity-aware aggregation across multiple L2 topic summaries for the same person/entity. Use case: "all the things I know about Alice" becomes a single L3 profile node that recall can surface OR drill into for full detail.

Without E5: each speaker:Alice topic summary stands alone in recall results, even when 10 of them all describe the same person.

## Goal

Four changes, all additive backward-compatible:

1. **buildEntityProfiles** new phase in dag.ts: clusters L2 summaries by entity tag, generates L3 profiles via existing generateDagSummary, links L2 children, clears born-dirty.

2. **Widen 5 SQL guards** in store.ts from `dag_level = 2` to `dag_level IN (2, 3)`. Rebuild path automatically handles dirty L3 via the same applyRebuildResult. Audit metadata reads actual level (NOT hardcoded constant) so L2 stays `dag_level: 2` and L3 emits `dag_level: 3`.

3. **drillDown depth** parameter in api.ts (+ MCP + HTTP + CLI pass-through). Default 1 preserves backward compat. Higher values walk N levels with visited-Set dedup.

4. **isDagSummary widening + cmdDag tree extension**: scoring deboost applies to both L2+L3; `hippo dag` tree view renders L3 nodes with their L2 children.

## Scope

### S1 — buildEntityProfiles in `src/dag.ts`

```typescript
export interface EntityProfilesBuildResult {
  candidateClusters: number;
  profilesCreated: number;
  l2sLinked: number;
}

/**
 * v0.30 / E5 — build L3 entity profiles by clustering L2 summaries by
 * shared entity tag. Threshold 2+ L2s per entity. Mirrors buildDag L1->L2
 * pattern, one level up. Same born-dirty cancellation via
 * clearSummaryDirtyAfterBuild with source='buildEntityProfiles-clean'.
 */
export async function buildEntityProfiles(
  hippoRoot: string,
  l2Summaries: MemoryEntry[],
  opts: DagSummaryOptions,
): Promise<EntityProfilesBuildResult> {
  const result: EntityProfilesBuildResult = {
    candidateClusters: 0,
    profilesCreated: 0,
    l2sLinked: 0,
  };

  // Only L2 with no L3 parent yet (avoid re-clustering already-profiled L2s).
  const unparented = l2Summaries.filter(
    (s) => s.dag_level === 2 && !s.dag_parent_id,
  );

  // Reuse existing clusterFacts; jaccard on entity tags.
  const clusters = clusterFacts(unparented);
  const eligible = clusters.filter((c) => c.members.length >= 2);
  result.candidateClusters = eligible.length;

  for (const cluster of eligible) {
    const summary = await generateDagSummary(
      cluster.label,
      cluster.members.map((m) => m.content),
      opts,
    );
    if (!summary) continue;

    const memberCreatedAts = cluster.members.map((m) => m.created).sort();
    const nowIso = new Date().toISOString();
    const profileEntry = createMemory(summary, {
      layer: Layer.Semantic,
      tags: [...cluster.entityTags, 'dag-entity-profile'],
      confidence: 'inferred',
      dag_level: 3,
    });
    profileEntry.descendant_count = cluster.members.length;
    profileEntry.earliest_at = memberCreatedAts[0];
    profileEntry.latest_at = memberCreatedAts[memberCreatedAts.length - 1];
    profileEntry.dag_level_3_built_at = nowIso;
    writeEntry(hippoRoot, profileEntry);
    result.profilesCreated++;

    for (const member of cluster.members) {
      const updated: MemoryEntry = { ...member, dag_parent_id: profileEntry.id };
      writeEntry(hippoRoot, updated);
      result.l2sLinked++;
    }
    // E3 born-dirty cancellation, same pattern as buildDag L161.
    // M3 FOLD: pass source='buildEntityProfiles-clean' via new source param.
    clearSummaryDirtyAfterBuild(
      hippoRoot,
      profileEntry.id,
      profileEntry.tenantId,
      'buildEntityProfiles',
      'buildEntityProfiles-clean',
    );
  }

  return result;
}
```

### S2 — Widen 5 SQL guards in `src/store.ts`

Change `AND dag_level = 2` to `AND dag_level IN (2, 3)` at:
- L2524: markSummaryDirtyInTx
- L2561: markSummaryDirty
- L2690: applyRebuildResult bumpRebuildCount=true branch
- L2700: applyRebuildResult bumpRebuildCount=false branch
- L2799: clearSummaryDirtyAfterBuild

**H1 FOLD — audit metadata strategy: use SQLite `RETURNING` clause (R2 must_fix perf fix)**:

R2 flagged that SELECT-before-UPDATE on every markSummaryDirtyInTx call doubles per-row DB ops in the hot path (5 caller sites: writeEntry, bulk writeMany, batch path, raw-archive, api.supersede). Solution: use `RETURNING dag_level` on the UPDATE — single round trip, captures actual level + change confirmation in one query.

For **markSummaryDirtyInTx** (store.ts:2513, R2 line anchor):
```typescript
const result = db.prepare(`
  UPDATE memories SET summary_dirty = 1
  WHERE id = ? AND tenant_id = ?
    AND dag_level IN (2, 3)
    AND summary_dirty = 0
    AND kind != 'archived'
  RETURNING dag_level
`).get(summaryId, tenantId) as { dag_level: number } | undefined;
if (result) {
  audit(db, 'summary_marked_dirty', summaryId, { dag_level: result.dag_level, source: 'E2' }, actor, tenantId);
}
```

For **markSummaryDirty** (store.ts:2546, R2 line anchor): same RETURNING shape.

For **applyRebuildResult** (store.ts:2748 audit call, R2 line anchor): caller already has full `summary: MemoryEntry` in scope. Pass `summary.dag_level` directly into audit metadata. No SELECT needed.

For **clearSummaryDirtyAfterBuild** (store.ts:2804 audit call, R2 line anchor): same RETURNING pattern as markSummaryDirty (caller may not have level — buildDag passes L2 entries, buildEntityProfiles passes L3 entries, but the helper stays level-agnostic).

**Performance note**: RETURNING is one round trip per call (same as the current UPDATE). Available in SQLite ≥3.35 (2021). node:sqlite ships with a much newer version. No regression vs current; better than the originally-proposed SELECT-before-UPDATE.

### S3 — Add `loadAllL2Summaries(hippoRoot)` to `src/store.ts` (H2 FOLD)

Tenant-host-wide helper mirroring `loadAllDirtySummaries`:

```typescript
/**
 * v0.30 / E5 — host-wide loader for L2 topic summaries without an L3 parent.
 * Used by consolidate phase 1.9 (buildEntityProfiles) to cluster L2s into
 * L3 entity profiles. Cheaper than re-running loadAllEntries; SQL filters
 * at index level. Returns entries with tenantId attached so per-cluster
 * writes stay tenant-scoped.
 */
export function loadAllL2Summaries(hippoRoot: string): MemoryEntry[] {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const rows = db.prepare(`
      SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories
       WHERE dag_level = 2
         AND dag_parent_id IS NULL
         AND kind != 'archived'
       ORDER BY created ASC, id ASC
    `).all() as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}
```

### S4 — Extend `isDagSummary` in `src/search.ts`

```typescript
// E5 widens predicate to L2 + L3 (single deboost factor for both).
// Differentiated deboost (e.g. 0.7 for L3) is follow-up scope.
export function isDagSummary(entry: MemoryEntry): boolean {
  return entry.dag_level === 2 || entry.dag_level === 3;
}
```

ScoreBreakdown `dagLevel` field automatically reflects 3 for L3 entries (already populated when dag_level !== undefined per E4 S3).

### S5 — Add `depth` to `drillDown` in `src/api.ts` (M1 + M5 FOLDS)

Extend DrillDownOpts:

```typescript
export interface DrillDownOpts {
  limit?: number;
  budget?: number;
  /** v0.30 / E5 — walk N levels down (default 1 = direct children only).
   *  Higher values include children of children, etc. Token budget remains
   *  GLOBAL (cumulative across levels), not per-level. BFS uses visited Set
   *  to dedup if data anomaly results in two parents sharing a child. */
  depth?: number;
}
```

Modify drillDown to walk with visited-Set dedup:

```typescript
export function drillDown(
  ctx: Context,
  summaryId: string,
  opts: DrillDownOpts = {},
): DrillDownOutcome {
  const limit = opts.limit ?? 50;
  const depth = Math.max(1, Math.min(opts.depth ?? 1, 10)); // hard cap 10 levels (R3 mitigation)
  // ... existing summary lookup + failure checks unchanged ...

  // BFS walk levels 1..depth with visited-Set dedup (M1 FOLD).
  const collected: MemoryEntry[] = [];
  const visited = new Set<string>([summaryId]); // include root so it can't reappear
  let frontier = [summaryId];
  for (let level = 0; level < depth; level++) {
    const nextFrontier: string[] = [];
    for (const parentId of frontier) {
      const kids = loadChildrenOf(ctx.hippoRoot, parentId, ctx.tenantId);
      const eligible = kids.filter((c) => passesScopeFilterForRecall(c.scope ?? null, undefined));
      for (const k of eligible) {
        if (visited.has(k.id)) continue; // dedup
        visited.add(k.id);
        collected.push(k);
        nextFrontier.push(k.id);
      }
    }
    if (nextFrontier.length === 0) break;
    frontier = nextFrontier;
  }

  // Apply global cumulative token budget + limit cap on collected.
  let children = collected;
  let truncated = false;
  if (opts.budget !== undefined) {
    const out: MemoryEntry[] = [];
    let used = 0;
    for (const c of collected) {
      const t = Math.ceil(c.content.length / 4);
      if (out.length > 0 && used + t > opts.budget) {
        truncated = true;
        break;
      }
      out.push(c);
      used += t;
    }
    children = out;
  }
  if (children.length > limit) {
    children = children.slice(0, limit);
    truncated = true;
  }

  return {
    summary: {
      id: summary.id,
      content: summary.content,
      // M5 FOLD: descendantCount stays at summary's STORED value (direct
      // children at L2/L3 creation time). totalChildren below reflects the
      // depth-walk collection (may be much larger).
      // R2 must-fix: `eligible` no longer exists in depth-walk rewrite;
      // fallback is `collected.length` (BFS-collected count).
      descendantCount: summary.descendant_count ?? collected.length,
      earliestAt: summary.earliest_at ?? null,
      latestAt: summary.latest_at ?? null,
    },
    children: children.map((c) => ({
      id: c.id,
      content: c.content,
      layer: c.layer,
      dagLevel: c.dag_level ?? 0,
      created: c.created,
    })),
    // M5 FOLD: totalChildren = collected.length after dedup, BEFORE
    // limit/budget cap. For depth=1 backward compat, this equals
    // eligible.length (same as pre-E5). For depth>1, this is the full
    // BFS-collected count.
    totalChildren: collected.length,
    truncated,
  };
}
```

### S6 — consolidate.ts wiring

Add phase 1.9 after 1.8 rebuild:

```typescript
// 1.9. DAG entity profiles — build L3 from clustered L2 summaries.
// Runs even when phase 1.7 was skipped (no extracted facts) — re-clusters
// existing L2s on every sleep regardless of new extraction.
if (apiKey && !dryRun) {
  try {
    const { buildEntityProfiles } = await import('./dag.js');
    const { loadAllL2Summaries } = await import('./store.js');
    const l2Summaries = loadAllL2Summaries(hippoRoot);
    if (l2Summaries.length >= 2) {
      const profileResult = await buildEntityProfiles(hippoRoot, l2Summaries, {
        apiKey,
        model: config.extraction.model,
      });
      result.entityProfilesCreated = profileResult.profilesCreated;
      if (profileResult.profilesCreated > 0) {
        result.details.push(`  🌲 DAG L3: ${profileResult.profilesCreated} entity profiles, ${profileResult.l2sLinked} L2s linked`);
      }
    }
  } catch {
    // Best-effort.
  }
}
```

Add `entityProfilesCreated: number` field to `ConsolidationResult` interface + init.

### S7 — CLI + HTTP + MCP pass-through for `--depth` (R2 cmdDrillDown rename + client-side clamps)

`cli.ts:4528` `cmdDrillDown` (R2 must-fix: function name corrected from cmdDrill): add `--depth N` argv parsing with client-side clamp `Math.max(1, Math.min(parsedDepth, 10))` so misuse is rejected at the CLI layer (defense-in-depth before reaching api.drillDown's internal clamp).

`server.ts:643` (HTTP /v1/drill): accept `depth` query param, clamp to `[1, 10]` at HTTP layer before calling api.drillDown.

`mcp/server.ts` (hippo_drill): add `depth?: number` to tool input schema with `minimum: 1, maximum: 10` so JSON schema validation enforces the cap before the call.

Default 1 everywhere, preserves backward compat. Triple-clamp (CLI/HTTP/MCP + internal) so any misconfigured caller surfaces the constraint at their layer rather than silent-clamping inside drillDown.

### S8 — cmdDag tree view extension (R1 L1 MED-promoted)

cli.ts:4479 currently:

```typescript
const summaries = entries.filter((e) => e.dag_level === 2);
```

E5 extends to render TWO-LEVEL tree: L3 → L2 → (optional L1 leaves). Pseudo-code:

```typescript
const profiles = entries.filter((e) => e.dag_level === 3);
const l2Map = new Map<string, MemoryEntry[]>(); // L3.id -> L2 children
const orphanL2 = []; // L2 with no L3 parent
for (const l2 of entries.filter((e) => e.dag_level === 2)) {
  if (l2.dag_parent_id) {
    const list = l2Map.get(l2.dag_parent_id) ?? [];
    list.push(l2);
    l2Map.set(l2.dag_parent_id, list);
  } else {
    orphanL2.push(l2);
  }
}

// Print L3 profiles as roots, with their L2 children indented.
for (const profile of profiles) {
  console.log(`🌲 ${profile.id} ${profile.content.slice(0, 60)}...`);
  const l2s = l2Map.get(profile.id) ?? [];
  for (const l2 of l2s) {
    console.log(`  └─ 🌳 ${l2.id} ${l2.content.slice(0, 60)}...`);
  }
}
// Then print orphan L2 (no L3 parent) at top level.
for (const l2 of orphanL2) {
  console.log(`🌳 ${l2.id} ${l2.content.slice(0, 60)}... (no L3 parent)`);
}
```

### S9 — Tests in `tests/dag-e5-entity-profiles.test.ts`

13 cases, all real-DB:

1. **buildEntityProfiles happy path**: 3 L2 summaries sharing speaker:Alice tag (no L3 parent), mocked fetcher returns synthetic profile. Verify 1 L3 created with dag_level=3, dag_level_3_built_at populated, descendant_count=3, all 3 L2s now have dag_parent_id pointing to L3.

2. **No clustering below threshold**: 1 L2 summary alone with speaker:Alice tag, buildEntityProfiles returns profilesCreated=0.

3. **Skips L2s with existing L3 parent**: 2 L2s with speaker:Alice (one already has dag_parent_id set to an existing L3) → only the unparented ones are eligible.

4. **L3 born-dirty cancellation** (M3 lock): After buildEntityProfiles, the new L3's summary_dirty must be 0. Audit row `summary_marked_clean` source='buildEntityProfiles-clean' exists. Audit metadata includes `dag_level: 3` (NOT hardcoded 2).

5. **markSummaryDirtyInTx widened to L3** (S2 lock): write an L2 with dag_parent_id pointing to an L3 → the L3's summary_dirty becomes 1 (was 0 before). Audit row `summary_marked_dirty` with target_id = L3.id AND `dag_level: 3` in metadata (H1 lock).

6. **rebuildDirtySummaries handles dirty L3** (M2 FOLD: with label-derivation + dag_level_3_built_at preservation assertions): pre-set summary_dirty=1 on an L3, mocked fetcher returns new L3 content. Verify: (a) fetcher was called with the L3's speaker:X tag as label (locks dag.ts:236-241 label path for L3), (b) content updated, (c) rebuild_count bumped, (d) last_rebuilt_at set to nowIso, (e) **dag_level_3_built_at UNCHANGED** (set once at create, not bumped on rebuild — locks S8 contract), (f) summary_dirty cleared, (g) audit row `summary_rebuilt` source='E3-rebuild' with `dag_level: 3`.

7. **drillDown depth=1 backward compat**: existing dag-drill-down tests still pass (depth=1 default = current behavior).

8. **drillDown depth=2 from L3 with dedup + totalChildren lock** (M1+M5 FOLDS): L3 has 2 L2 children, each L2 has 3 L1 children. drillDown(L3.id, {depth: 2}) returns 8 entries (2 L2s + 6 L1s). Assert: (a) all returned ids unique (Set size = collected.length), (b) `totalChildren === 8` (post-BFS collect), (c) `summary.descendantCount === 2` (L3's stored value — UNCHANGED by depth walk).

9. **drillDown depth=3 from L3**: same setup, depth=3 (BFS exhausts at depth=2 since L1s have no children). Returns same 8 entries (no over-walk).

10. **drillDown depth global budget**: depth=2, budget cap forces truncation mid-walk → truncated=true.

11. **drillDown depth tenant isolation** (R1 L2 FOLD — strengthened setup): L3 + L2-A both in tenant-a (L2-A.dag_parent_id = L3.id). L1-Bs in tenant-b with L1-B.dag_parent_id = L2-A.id (data anomaly via direct SQL). drillDown(L3, depth=2) from tenant-a context should return [L2-A] but EXCLUDE L1-Bs (loadChildrenOf at level 2 is tenant-scoped on tenant-a; L1-Bs in tenant-b don't appear).

12. **isDagSummary extension** (S4 lock): assert isDagSummary({dag_level: 2}) === true, isDagSummary({dag_level: 3}) === true, isDagSummary({dag_level: 1}) === false, isDagSummary({dag_level: 0}) === false.

13. **E4 deboost applies to L3 in hybridSearch** (S4 integration lock): write L3 entity profile, query, verify breakdown.summaryDeboost = 0.85 and breakdown.dagLevel = 3.

### S10 — Scope boundary

NOT in E5:
- Differentiated deboost (L2: 0.85, L3: 0.7) — follow-up if benchmark shows L3 dominates
- **L3 substitution in api.recall overflow path** — pinned at api.ts:542, :553, :883 (THREE sites, R1 L4 enumeration). Out of scope; separate refactor.
- L4 hierarchy (not anticipated)
- CLI `hippo entity-profiles` standalone command (consolidate runs it automatically)
- HTTP /v1/entity-profiles endpoint (drillDown depth gives equivalent access)
- Recomputing dag_level_3_built_at on rebuild (set once at create; rebuild bumps last_rebuilt_at instead)
- buildEntityProfiles freshness re-clustering (existing L3s with stale L2 membership)

## Acceptance criteria

1. AC1: `buildEntityProfiles(hippoRoot, l2Summaries, opts)` creates L3 profiles from clusters of unparented L2s. Threshold 2+ members per cluster.
2. AC2: New L3 entries have dag_level=3, dag_parent_id=null, dag_level_3_built_at populated, descendant_count + earliest/latest_at populated.
3. AC3: All cluster members get dag_parent_id pointing to new L3 (linked).
4. AC4: clearSummaryDirtyAfterBuild fires on new L3 (born-dirty cancellation). Audit `summary_marked_clean` source='buildEntityProfiles-clean' with `dag_level: 3` metadata.
5. AC5: All 5 SQL guards in store.ts widened from `dag_level = 2` to `IN (2, 3)`. Audit metadata reads actual level (NOT hardcoded). Tests 4+5+6 lock the behavior.
6. AC6: rebuildDirtySummaries handles dirty L3 via same applyRebuildResult path. dag_level_3_built_at UNCHANGED on rebuild (only last_rebuilt_at + rebuild_count). Test 6 locks.
7. AC7: drillDown gains `depth?:number` opt (default 1, backward compat, hard cap 10). Tests 7+8+9 lock behavior. Visited-Set dedup prevents double-emit.
8. AC8: drillDown depth budget is global cumulative. Test 10 locks.
9. AC9: drillDown depth respects tenant isolation at each level. Test 11 locks (strengthened setup).
10. AC10: isDagSummary extended to L2 + L3 (single deboost factor). Test 12 locks; test 13 locks E4 deboost integration.
11. AC11: consolidate runs phase 1.9 (buildEntityProfiles) after 1.8 (rebuild) via NEW `loadAllL2Summaries` helper (NOT `survivors` which lacks newly-created L2s). ConsolidationResult.entityProfilesCreated populated.
12. AC12: CLI `hippo drill --depth N` + HTTP /v1/drill?depth=N + MCP hippo_drill `depth` arg pass through. Hard cap 10.
13. AC13: cmdDag tree view renders L3 profiles as roots with L2 children indented (S8 NEW).
14. AC14: drillDown.totalChildren reflects BFS-collected count (depth-aware); summary.descendantCount reflects L3's stored direct-child count (unchanged by depth). Test 8 locks both.
15. AC15: All 13 new tests pass.
16. AC16: No regression — full test suite green. dag-dirty-flag-schema.test.ts:165 still passes (L2 → dag_level: 2). Rename test :102 wording to "(dag_level NOT IN (2, 3))" — non-functional rename.

## Risks (R1 updates folded)

1. **R1 (RESOLVED in v2)**: audit metadata "drop hardcoded" decision reverted to "read actual level". No test breakage.
2. **R2 (RESOLVED in v2)**: phase 1.9 data source: `loadAllL2Summaries` helper, NOT `survivors`.
3. **R3 (LOW)**: drillDown BFS could collect a large set before truncation. Hard cap depth=10 + visited-Set dedup + token budget + limit cap. Acceptable.
4. **R4 (LOW)**: Snapshot tests on `hippo sleep` output may diff for the new "🌲 DAG L3" details line. Scan in execute stage.
5. **R5 (MED, promoted from LOW)**: cmdDag tree view extended (S8 NEW) to render L3.
6. **R6 (LOW)**: rebuildDirtySummaries' generateDagSummary for L3 uses L2 contents as "facts". L2 content is already summary-shaped; LLM may produce odd meta-summary. Acceptable for E5; quality tuning is follow-up.
7. **R7 (LOW, NEW)**: dag-recall-first-class.test.ts:315 should add `isDagSummary({dag_level: 3}) === true` case (or covered by E5 test #12).

## Out of scope (deferred)

- Differentiated L2 vs L3 deboost factors in search.ts
- L3 substitution in api.recall overflow path (3 sites at api.ts:542/553/883)
- L4 hierarchy
- Standalone CLI / HTTP endpoints for entity profiles
- buildEntityProfiles freshness re-clustering (existing L3s with stale L2 membership)

## Ship pattern (E4 retro lessons applied)

Stacked PR off `feat-dag-e4-recall`. PR #70 expected. Per gh-cascade memory: plain `gh pr merge 69 --rebase` on E4 merge (NO --delete-branch).

Title (E3+E4 retro, ≤70 chars, no em dash, drop arc suffix): `feat(dag): E5 level-3 entity profiles + drillDown depth` (54 chars).

**Pre-commit em-dash grep ritual (R1 L3 specified explicitly per E4 retro feedback memory)**:

```bash
# Before git commit:
git diff --cached -- src/ tests/ docs/ | grep -nP '\xe2\x80\x94' && echo "EM DASH DETECTED — fix before commit" && exit 1
# Or simpler for the commit message itself: write commit message to a temp file first, then:
grep -nP '\xe2\x80\x94' /tmp/commit-msg.txt && echo "EM DASH IN COMMIT MSG" && exit 1
# Same for PR body before gh pr create.
```

Plan body uses em dashes freely (internal doc, NOT restricted per Stop Slop). Commit message + PR body must be em-dash-free.

After E5 ship-ready: bundled merge sequence (E1 → E2 → E3 → E4 → E5) + `npm publish` v1.12.12 per Keith's "one bundled release" pick.
