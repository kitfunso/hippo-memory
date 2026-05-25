# 2026-05-25 — DAG live-coupling E3: sleep-cycle rebuildDirtySummaries phase

**Status:** Draft v2.1 (R2 PASS score 8 — 1 must-fix + 4 LOW polish folded inline)
**Episode:** 01KSGB90ZC21XYTBGRASHDGFA3
**Branch:** feat-dag-e3-rebuild-summaries (off feat-dag-e2-dirty-propagation; stacked PR — do NOT --delete-branch E2 on merge or this auto-closes)
**Owner:** Claude (Keith review)

## Discover refinement (hoisted per "Discover IS a scope-decision stage" memory)

Brainstorm framing: "add rebuildDirtySummaries phase to consolidate.ts".

Discover-stage code reads against the actual call graph and current store surface:

- **`loadDirtySummaries(hippoRoot, tenantId)` is already exported at `store.ts:2475`** (E1 planted the reader). Per-tenant signature. consolidate.ts runs host-wide (`loadAllEntries(hippoRoot)` at L110, comment L106-109 explicit: "host-wide by design").
- **`generateDagSummary(label, factContents, opts)` at `dag.ts:64`** is reusable as-is. Takes apiKey, model, optional fetcher. Returns string|null. Null on fetch error, non-OK status, or response under 20 chars.
- **`buildDag` invocation site at `consolidate.ts:299-308`** is the natural anchor. Same `apiKey && ... && !dryRun` gate, dynamic `await import('./dag.js')`. Rebuild MUST share this gate.
- **CRITICAL R1 finding — store.ts helpers are module-private**: `MEMORY_SELECT_COLUMNS` (L199), `MemoryRow` (L71), `rowToEntry` (L388), `audit` (L32), `syncFtsRow` (L1013), `deleteFtsRow` (L1027), `assertTenantId` (~L1818) all are NOT exported. Plan v1 wrongly placed `loadAllDirtySummaries` + `loadChildrenOfSummary` + `applyRebuildResult` in dag.ts where these helpers are out of scope. **Plan v2 decision: all three live in store.ts** (where the private helpers are in scope). dag.ts owns only the thin `rebuildDirtySummaries` orchestrator (which calls into store.ts for load + apply, and into `generateDagSummary` for the LLM bit).
- **CRITICAL R1 finding — born-dirty + double-rebuild loop**: dag.ts:152-156 buildDag's child-link loop calls `writeEntry(hippoRoot, updated)` where `updated.dag_parent_id = summaryEntry.id`. writeEntryDbOnly fires `markSummaryDirtyInTx` (store.ts:1214-1216) on the just-created summary. Without intervention, E3 in the SAME sleep cycle would re-rebuild every new summary (2x LLM cost). **Plan v2 fix: add `clearSummaryDirtyAfterBuild(hippoRoot, summaryId, tenantId)` to store.ts; buildDag calls it after the child-link loop**. Marks the freshly-built summary clean (intentional cancellation of the cascade of dirty-marks from the linkage step). Audit row source='buildDag-clean' for traceability.
- **CRITICAL R1 finding — FTS desync**: bare `UPDATE memories SET content=?` does not update memories_fts. Plan v1's applyRebuildResult would leave FTS index stale. **Plan v2 fix: applyRebuildResult lives in store.ts where syncFtsRow is in scope; call it after the UPDATE inside the same SAVEPOINT.**
- **Per-summary children** loaded via `loadChildrenOfSummary(hippoRoot, summaryId, tenantId)` — new reader in store.ts (S2 below).

Brainstorm carry-forward concerns (memory rule — each addressed explicitly):

1. **Zero-child case** (all descendants archived/forgotten since last rebuild): rebuild SKIPS LLM call, BUT clears `summary_dirty=0`, sets `descendant_count=0`, `earliest_at=NULL`, `latest_at=NULL`. Does NOT delete summary (E5 reaper territory). Does NOT bump `rebuild_count` (no semantic rebuild). Audit `metadata.zero_children=true`.
2. **Failure handling** (`generateDagSummary` returns null OR throws): leave `summary_dirty=1`, do NOT bump `rebuild_count`, no UPDATE, no audit. Next sleep cycle retries. R1 must-fix: per-summary try/catch wrapping LLM call + applyRebuildResult so one failure doesn't abort the queue.
3. **Atomicity**: the column updates (content + last_rebuilt_at + rebuild_count++ + descendant_count + earliest_at + latest_at + summary_dirty=0) are one prepared UPDATE statement plus syncFtsRow inside one SAVEPOINT (SAVEPOINT for nested-tx safety, NOT bare BEGIN per R1 LOW issue). R1 must-fix: test #8 reframed to inspect prepared SQL.
4. **Tenancy seam**: `loadAllDirtySummaries(hippoRoot)` host-wide cross-tenant variant in store.ts. Results carry `tenantId` so per-summary children + UPDATE WHERE both stay tenant-scoped.
5. **Cost cap**: HIPPO_DAG_REBUILD_CAP env var, default 20, **HARD CEILING 1000** (R1 must-fix — `Math.min(parsed, 1000)`).
6. **Race window (R1 MED #5)**: applyRebuildResult UPDATE adds `AND summary_dirty = 1` to WHERE so concurrent sleep's race-loser becomes a no-op (result.changes===0 → treat as skipped, no audit, no bump).
7. **Observability gap (R1 MED #8)**: ConsolidationResult gains `summariesRebuilt`, `summariesRebuildFailed`, `summariesZeroChildSkipped`, `summariesRebuildCapped`. Not just the rebuilt count.

## Why this exists

E3 of 5-episode DAG live-coupling arc. E1 shipped schema (PR #66). E2 shipped child-write dirty-flag propagation (PR #67). E3 is the consumer: walks dirty L2 summaries and regenerates them. Without E3, `summary_dirty=1` accumulates forever and cached content stays stale.

## Goal

In one sleep-cycle phase, drain the dirty queue (capped at 20, ceiling 1000):

1. Load dirty L2 summaries across all tenants
2. For each: load children → regenerate via `generateDagSummary` → atomically write content + 6 metadata + clear dirty (with FTS sync)
3. Report `summariesRebuilt` + `summariesRebuildFailed` + `summariesZeroChildSkipped` + `summariesRebuildCapped` in `ConsolidationResult`

Zero-child summaries pass through faster (no LLM call) but still get dirty flag cleared + counts zeroed (no rebuild_count bump). Failed rebuilds leave dirty=1 for next cycle. Concurrent sleep races collapse via `AND summary_dirty = 1` UPDATE guard.

## Scope

### S1 — `loadAllDirtySummaries(hippoRoot)` in `src/store.ts`

Host-wide cross-tenant variant of existing `loadDirtySummaries`. ~25 lines, sibling export.

```typescript
/**
 * v0.30 / E3 — host-wide variant of loadDirtySummaries. Iterates all tenants
 * in one query so consolidate.ts (which runs host-wide per L106-109) does not
 * need a per-tenant loop. Each returned MemoryEntry carries its own tenantId
 * (via rowToEntry), so per-summary children + rebuild UPDATE stay tenant-scoped.
 *
 * Sort: latest_at DESC NULLS LAST, id ASC — same as per-tenant variant so
 * HIPPO_DAG_REBUILD_CAP takes most-recently-changed summaries first.
 */
export function loadAllDirtySummaries(hippoRoot: string): MemoryEntry[] {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const rows = db.prepare(`
      SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories
       WHERE summary_dirty = 1
         AND kind != 'archived'
       ORDER BY latest_at DESC NULLS LAST, id ASC
    `).all() as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}
```

### S2 — `loadChildrenOfSummary(hippoRoot, summaryId, tenantId)` in `src/store.ts`

```typescript
/**
 * v0.30 / E3 — load live children of a DAG summary. Used by
 * rebuildDirtySummaries to regenerate content from the CURRENT child set
 * (not the children at create-time). Skips archived. Tenant-scoped (defence
 * in depth — dag_parent_id is unique-ish but tenant guard is cheap).
 *
 * created column is TEXT NOT NULL since db.ts schema v1, so plain
 * ORDER BY created ASC is safe (no NULLS handling needed).
 */
export function loadChildrenOfSummary(
  hippoRoot: string,
  summaryId: string,
  tenantId: string,
): MemoryEntry[] {
  assertTenantId('loadChildrenOfSummary', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const rows = db.prepare(`
      SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories
       WHERE dag_parent_id = ?
         AND tenant_id = ?
         AND kind != 'archived'
       ORDER BY created ASC
    `).all(summaryId, tenantId) as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}
```

### S3 — `applyRebuildResult(hippoRoot, summary, patch)` in `src/store.ts`

Lives in store.ts (R1 fix) where audit + syncFtsRow + assertTenantId are in scope. Atomic UPDATE-then-FTS-sync inside one SAVEPOINT.

```typescript
/**
 * v0.30 / E3 — apply a rebuild result to a dirty summary. Atomic: 7-column
 * UPDATE (or 4-column for zero-child branch) plus syncFtsRow inside one
 * SAVEPOINT. WHERE includes `summary_dirty = 1` so concurrent sleeps make
 * the race-loser a no-op (no rebuild_count bump, no audit row).
 *
 * Returns true on actual rebuild (changes > 0), false on race-loss / unknown id.
 */
export interface RebuildPatch {
  content: string;            // new content for normal rebuild; summary.content for zero-child
  descendant_count: number;
  earliest_at: string | null;
  latest_at: string | null;
  bumpRebuildCount: boolean;  // true on normal rebuild; false on zero-child
  zeroChildren: boolean;
  actor: string;
}

export function applyRebuildResult(
  hippoRoot: string,
  summary: MemoryEntry,
  patch: RebuildPatch,
): boolean {
  assertTenantId('applyRebuildResult', summary.tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('SAVEPOINT rebuild_summary');
    try {
      const nowIso = new Date().toISOString();
      // ONE prepared statement per branch. Test #8 inspects this SQL string.
      const sql = patch.bumpRebuildCount
        ? `UPDATE memories
              SET content = ?,
                  descendant_count = ?,
                  earliest_at = ?,
                  latest_at = ?,
                  last_rebuilt_at = ?,
                  rebuild_count = COALESCE(rebuild_count, 0) + 1,
                  summary_dirty = 0
            WHERE id = ?
              AND tenant_id = ?
              AND dag_level = 2
              AND summary_dirty = 1
              AND kind != 'archived'`
        : `UPDATE memories
              SET descendant_count = ?,
                  earliest_at = ?,
                  latest_at = ?,
                  summary_dirty = 0
            WHERE id = ?
              AND tenant_id = ?
              AND dag_level = 2
              AND summary_dirty = 1
              AND kind != 'archived'`;

      const result = patch.bumpRebuildCount
        ? db.prepare(sql).run(
            patch.content,
            patch.descendant_count,
            patch.earliest_at,
            patch.latest_at,
            nowIso,
            summary.id,
            summary.tenantId,
          )
        : db.prepare(sql).run(
            patch.descendant_count,
            patch.earliest_at,
            patch.latest_at,
            summary.id,
            summary.tenantId,
          );

      const changed = (result.changes ?? 0) > 0;

      if (changed) {
        // FTS sync — bare UPDATE on memories does NOT update memories_fts.
        // R1 HIGH must-fix. Construct the patched entry in memory and reuse
        // the existing syncFtsRow helper (delete-then-insert).
        const patchedEntry: MemoryEntry = {
          ...summary,
          content: patch.content,
          descendant_count: patch.descendant_count,
          // R2 must-fix: keep null semantics — MemoryEntry.earliest_at/latest_at
          // typing is `string | null`; coercing to undefined loses the distinction.
          earliest_at: patch.earliest_at,
          latest_at: patch.latest_at,
          summary_dirty: 0,
          last_rebuilt_at: patch.bumpRebuildCount ? nowIso : summary.last_rebuilt_at,
          rebuild_count: patch.bumpRebuildCount
            ? (summary.rebuild_count ?? 0) + 1
            : summary.rebuild_count,
        };
        syncFtsRow(db, patchedEntry);

        audit(
          db,
          'summary_rebuilt',
          summary.id,
          {
            dag_level: 2,
            source: 'E3-rebuild',
            zero_children: patch.zeroChildren,
            descendant_count: patch.descendant_count,
          },
          patch.actor,
          summary.tenantId,
        );
      }

      db.exec('RELEASE SAVEPOINT rebuild_summary');
      return changed;
    } catch (e) {
      try {
        db.exec('ROLLBACK TO SAVEPOINT rebuild_summary');
        db.exec('RELEASE SAVEPOINT rebuild_summary');
      } catch {}
      throw e;
    }
  } finally {
    closeHippoDb(db);
  }
}
```

### S4 — `clearSummaryDirtyAfterBuild(hippoRoot, summaryId, tenantId)` in `src/store.ts`

R1 HIGH #2 must-fix. Cancels the cascade of dirty-marks fired during buildDag's child-link loop on a freshly-created summary (so E3 doesn't re-rebuild brand-new summaries on the same sleep cycle).

```typescript
/**
 * v0.30 / E3 — clear summary_dirty on a freshly-built summary. Called by
 * buildDag immediately after the child-link loop finishes. Without this,
 * each member's writeEntry call fires markSummaryDirtyInTx on the just-
 * created parent (E2 hook at store.ts:1214), and the same sleep cycle's
 * E3 rebuild phase would re-rebuild every new summary, doubling LLM cost.
 *
 * Idempotent: no-op + no audit if summary isn't dirty (e.g. someone wrote
 * a child between flag clear and audit emit — that's a fresh genuine
 * dirty-mark, not a buildDag artifact, leave it alone). Audit
 * source='buildDag-clean' for traceability vs E3 rebuilds.
 */
export function clearSummaryDirtyAfterBuild(
  hippoRoot: string,
  summaryId: string,
  tenantId: string,
  actor: string = 'cli',
): void {
  assertTenantId('clearSummaryDirtyAfterBuild', tenantId);
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const result = db.prepare(`
      UPDATE memories
         SET summary_dirty = 0
       WHERE id = ?
         AND tenant_id = ?
         AND dag_level = 2
         AND summary_dirty = 1
         AND kind != 'archived'
    `).run(summaryId, tenantId);
    if ((result.changes ?? 0) > 0) {
      audit(db, 'summary_marked_clean', summaryId, { dag_level: 2, source: 'buildDag-clean' }, actor, tenantId);
    }
  } finally {
    closeHippoDb(db);
  }
}
```

### S5 — `rebuildDirtySummaries(hippoRoot, opts)` in `src/dag.ts`

Thin orchestrator. Loads queue via store.ts, iterates per-summary with try/catch isolation, calls LLM via generateDagSummary, applies via applyRebuildResult.

```typescript
import { loadAllDirtySummaries, loadChildrenOfSummary, applyRebuildResult } from './store.js';

export interface DagRebuildResult {
  attempted: number;            // summaries we tried (≤ cap)
  rebuilt: number;              // successful regenerations
  zeroChildSkipped: number;     // dirty-cleared without LLM
  failed: number;               // LLM null, fetch error, or applyRebuildResult throw
  capped: boolean;              // queue had more than cap entries
}

export async function rebuildDirtySummaries(
  hippoRoot: string,
  opts: DagSummaryOptions & { cap?: number },
): Promise<DagRebuildResult> {
  const cap = opts.cap ?? 20;
  const dirty = loadAllDirtySummaries(hippoRoot);
  const capped = dirty.length > cap;
  const queue = dirty.slice(0, cap);

  const result: DagRebuildResult = {
    attempted: queue.length,
    rebuilt: 0,
    zeroChildSkipped: 0,
    failed: 0,
    capped,
  };

  for (const summary of queue) {
    try {
      const children = loadChildrenOfSummary(hippoRoot, summary.id, summary.tenantId);

      if (children.length === 0) {
        // Zero-child case: no LLM call, no rebuild_count bump, clear dirty + zero counts.
        const changed = applyRebuildResult(hippoRoot, summary, {
          content: summary.content,
          descendant_count: 0,
          earliest_at: null,
          latest_at: null,
          bumpRebuildCount: false,
          zeroChildren: true,
          actor: 'sleep',
        });
        if (changed) result.zeroChildSkipped++;
        // changed=false → race lost or row vanished; silently skip
        continue;
      }

      // Derive label from summary's existing entity tags (mirrors dag.ts clusterFacts)
      const entityTags = summary.tags.filter(
        (t) => t.startsWith('speaker:') || t.startsWith('topic:'),
      );
      const label = entityTags.length > 0
        ? entityTags.map((t) => t.split(':')[1]).join(': ')
        : summary.content.slice(0, 40);

      const newContent = await generateDagSummary(
        label,
        children.map((c) => c.content),
        opts,
      );

      if (!newContent) {
        // LLM null or fetch error → leave dirty for next cycle
        result.failed++;
        continue;
      }

      const childCreatedAts = children.map((c) => c.created).sort();
      const changed = applyRebuildResult(hippoRoot, summary, {
        content: newContent,
        descendant_count: children.length,
        earliest_at: childCreatedAts[0],
        latest_at: childCreatedAts[childCreatedAts.length - 1],
        bumpRebuildCount: true,
        zeroChildren: false,
        actor: 'sleep',
      });
      if (changed) result.rebuilt++;
      // changed=false → race lost; not a failure, not a success, silently skip
    } catch {
      // R1 MED #6 must-fix — per-summary failure isolation. One throwing
      // applyRebuildResult must NOT abort the rest of the queue.
      result.failed++;
    }
  }

  return result;
}
```

### S6 — `buildDag` post-link clean call in `src/dag.ts`

R1 HIGH #2 fix. Add ONE LINE after the child-link loop (current L156):

```typescript
import { clearSummaryDirtyAfterBuild } from './store.js';  // top-of-file

// Inside buildDag, replace L149-156 with:
    writeEntry(hippoRoot, summaryEntry);
    result.summariesCreated++;

    for (const member of cluster.members) {
      const updated: MemoryEntry = { ...member, dag_parent_id: summaryEntry.id };
      writeEntry(hippoRoot, updated);
      result.factsLinked++;
    }
    // v0.30 / E3 — cancel the cascade of dirty-marks fired by member
    // writeEntry calls (E2 hook on writeEntryDbOnly). The summary we just
    // built IS fresh, no rebuild needed. Without this, E3 in the SAME
    // sleep cycle would re-rebuild every new summary (2x LLM cost).
    clearSummaryDirtyAfterBuild(hippoRoot, summaryEntry.id, summaryEntry.tenantId, 'buildDag');
```

### S7 — `consolidate.ts` wiring

R1 MED #8 fix: ConsolidationResult gains FOUR fields, not one.

```typescript
// Add to ConsolidationResult interface at L62-76:
  summariesRebuilt: number;
  summariesRebuildFailed: number;
  summariesZeroChildSkipped: number;
  summariesRebuildCapped: boolean;

// Initialize in result at L90-104:
  summariesRebuilt: 0,
  summariesRebuildFailed: 0,
  summariesZeroChildSkipped: 0,
  summariesRebuildCapped: false,
```

Phase wiring at L312 (right after buildDag block):

```typescript
// -------------------------------------------------------------------------
// 1.8. DAG summary rebuild — drain dirty queue from E2's child-write hooks
// -------------------------------------------------------------------------
if (apiKey && !dryRun) {
  try {
    const { rebuildDirtySummaries } = await import('./dag.js');
    const rawCap = parseInt(process.env.HIPPO_DAG_REBUILD_CAP ?? '20', 10);
    // R1 MED #9 must-fix — hard ceiling 1000 so misconfigured env can't
    // burn unbounded LLM cost.
    const cap = Number.isFinite(rawCap) && rawCap > 0
      ? Math.min(rawCap, 1000)
      : 20;
    const rebuildResult = await rebuildDirtySummaries(hippoRoot, {
      apiKey,
      model: config.extraction.model,
      cap,
    });
    result.summariesRebuilt = rebuildResult.rebuilt;
    result.summariesRebuildFailed = rebuildResult.failed;
    result.summariesZeroChildSkipped = rebuildResult.zeroChildSkipped;
    result.summariesRebuildCapped = rebuildResult.capped;
    if (rebuildResult.rebuilt > 0 || rebuildResult.zeroChildSkipped > 0 || rebuildResult.failed > 0) {
      const parts: string[] = [];
      if (rebuildResult.rebuilt > 0) parts.push(`${rebuildResult.rebuilt} rebuilt`);
      if (rebuildResult.zeroChildSkipped > 0) parts.push(`${rebuildResult.zeroChildSkipped} zero-child-skipped`);
      if (rebuildResult.failed > 0) parts.push(`${rebuildResult.failed} failed`);
      if (rebuildResult.capped) parts.push(`CAPPED@${cap}`);
      result.details.push(`  🌳 DAG rebuild: ${parts.join(', ')}`);
    }
  } catch {
    // Best-effort — same posture as buildDag block above.
  }
}
```

### S8 — Tests in `tests/dag-rebuild-summaries.test.ts`

12 cases, all real-DB, fetch mocked via fetcher injection (DagSummaryOptions accepts a fetcher; see dag.ts:53):

1. **Happy path**: 1 dirty summary, 3 children, mocked fetcher returns new content (≥20 chars to pass generateDagSummary length guard at dag.ts:101). Verify content updated, summary_dirty=0, rebuild_count=1, last_rebuilt_at set, descendant_count=3, earliest_at/latest_at match children. Audit row `summary_rebuilt` emitted with source='E3-rebuild'. **FTS row also updated** (query memories_fts directly for the rebuilt content snippet).
2. **Idempotent re-run**: Re-call rebuildDirtySummaries with no further mutations → second call returns `attempted=0, rebuilt=0, failed=0, zeroChildSkipped=0, capped=false`. Row state from first call (rebuild_count=1, summary_dirty=0) UNCHANGED.
3. **Multi-tenant isolation**: 2 dirty summaries in different tenants. Both rebuilt. Each fetcher invocation receives ONLY the correct tenant's children content. No cross-tenant leakage.
4. **Cap enforcement**: 25 dirty summaries, cap=20 → attempted=20, capped=true, 5 remain dirty.
5. **Zero-child case**: dirty summary whose only child was archived (raw-archive) → no fetcher call, summary_dirty=0, descendant_count=0, earliest_at/latest_at NULL, **rebuild_count UNCHANGED**, audit zero_children=true.
6. **Fetcher throws**: fetcher injection throws → result.failed++, summary remains summary_dirty=1, rebuild_count UNCHANGED, no audit, **next dirty summary IS still processed** (loop didn't abort).
7. **Fetcher returns null** (HTTP non-OK): same as #6.
8. **Atomicity** (R1 MED #7 reframed): assert applyRebuildResult issues exactly ONE prepared statement for the UPDATE. Use `jest.spyOn(db, 'prepare')` to count distinct SQL strings; verify only one UPDATE-against-memories SQL is prepared per applyRebuildResult call (plus the syncFtsRow internal prepares, which we count separately by inspecting the SQL strings — UPDATE memories appears exactly once).
9. **No apiKey gate**: env without ANTHROPIC_API_KEY → rebuild phase skipped, summary_dirty stays 1 across sleep cycle.
10. **R1 HIGH #2 regression — buildDag clean-up**: invoke buildDag with apiKey + injected fetcher returning synthetic 200 response with content payload `'synthetic summary X'` (≥20 chars to satisfy generateDagSummary length guard at dag.ts:101). Assert the just-created summary has summary_dirty=0 immediately after buildDag returns (and an audit row `summary_marked_clean` source='buildDag-clean' exists). Then run rebuildDirtySummaries → result.attempted=0 (no rebuild). This locks the born-dirty fix and prevents regression.
11. **R1 MED #5 race-loser**: pre-set summary_dirty=0 (simulating a concurrent sleep already cleared it), run rebuildDirtySummaries → applyRebuildResult's UPDATE returns changes=0. Assert: `result.rebuilt` and `result.failed` BOTH unchanged (remain 0), no audit `summary_rebuilt` row exists, summary's rebuild_count UNCHANGED on the row.
12. **R2 LOW must-fix — cap ceiling**: set `HIPPO_DAG_REBUILD_CAP=99999`, seed 1500 dirty summaries (mocked fetcher returns short fixed content), invoke `consolidate()`. Assert `result.summariesRebuilt + result.summariesZeroChildSkipped + result.summariesRebuildFailed ≤ 1000` AND `result.summariesRebuildCapped === true`. Locks the `Math.min(rawCap, 1000)` guard against silent removal.

### S9 — Scope boundary

NOT in E3:
- Level-3 entity-profile summaries (E5)
- Orphan-summary reaper (zero-child summaries linger; observed, not deleted)
- Rebuild scheduling outside sleep cycle (manual `hippo rebuild` CLI — defer)
- Recall integration of `last_rebuilt_at` / freshness boost (E4)
- Cross-process race detection beyond UPDATE WHERE guard (no advisory lock)

## Acceptance criteria

1. AC1: `loadAllDirtySummaries(hippoRoot)` returns dirty L2 summaries across all tenants, sorted latest_at DESC NULLS LAST, id ASC.
2. AC2: `loadChildrenOfSummary(hippoRoot, summaryId, tenantId)` returns non-archived children only, sorted created ASC.
3. AC3: `rebuildDirtySummaries(hippoRoot, opts)` happy path: content replaced, rebuild_count++, last_rebuilt_at set, descendant_count + earliest_at + latest_at recomputed, summary_dirty cleared, **memories_fts row synced**. Audit `summary_rebuilt` row emitted with source='E3-rebuild'.
4. AC4: Zero-child: summary_dirty cleared + counts zeroed BUT rebuild_count UNCHANGED, audit `zero_children=true`. No fetcher invocation. FTS row content unchanged (still old content; consistent with no semantic rebuild).
5. AC5: Failure (null return / throw): summary_dirty STAYS 1, rebuild_count UNCHANGED, no audit. Next cycle retries. Loop does NOT abort — remaining queued summaries still processed.
6. AC6: Column updates atomic — one prepared UPDATE statement (not 7 separate) PLUS syncFtsRow inside one SAVEPOINT.
7. AC7: Cap: `HIPPO_DAG_REBUILD_CAP=20` default, env override respected, invalid values fall back to 20, **HARD CEILING 1000 via Math.min**.
8. AC8: `ConsolidationResult` gains 4 fields: `summariesRebuilt`, `summariesRebuildFailed`, `summariesZeroChildSkipped`, `summariesRebuildCapped`. Details string emitted only when non-zero.
9. AC9: Multi-tenant isolation — per-summary children query stays tenant-scoped via summary.tenantId.
10. AC10: apiKey/dryRun gate shared with buildDag block — no API call when key absent or dryRun.
11. AC11: store.ts holds the 4 new functions (loadAllDirtySummaries, loadChildrenOfSummary, applyRebuildResult, clearSummaryDirtyAfterBuild) — dag.ts holds only the thin orchestrator. R1 HIGH #1 fix.
12. AC12: `buildDag` calls `clearSummaryDirtyAfterBuild` after child-link loop so freshly-built summaries are NOT re-rebuilt on the same sleep cycle. R1 HIGH #2 fix. Audit row `summary_marked_clean` source='buildDag-clean'.
13. AC13: applyRebuildResult UPDATE WHERE includes `AND summary_dirty = 1` so concurrent sleeps make race-loser a no-op (R1 MED #5).
14. AC14: rebuildDirtySummaries loop has per-summary try/catch — one throw doesn't abort remaining queue (R1 MED #6).
15. AC15: All 12 tests pass against real DB.
16. AC16: No regression — full test suite green.

## Risks (R1 prior risks updated; some retired)

1. **R1 (RESOLVED in plan v2)**: Module-private helpers → moved all store-touching code into store.ts.
2. **R2 (RESOLVED — was overcautious)**: `created` is TEXT NOT NULL since v1, no NULLS handling needed in loadChildrenOfSummary ORDER BY.
3. **R3 (MED — kept)**: cap=20 vs unbounded dirty queue. Capped=true flag surfaced in details + ConsolidationResult so visible to operators.
4. **R4 (MED — kept)**: Snapshot tests on `hippo sleep` output — new "🌳 DAG rebuild" line will diff. Mitigation: search for snapshots in execute stage, update.
5. **R5 (LOW — kept)**: Tag-derived label drift. Children's content drives summary text via LLM prompt; label is a cue. Re-clustering is E5.
6. **R6 (LOW — kept)**: applyRebuildResult opens own db connection per summary. 20 open/close cycles, acceptable, matches per-summary failure-isolation.
7. **R7 (LOW — kept)**: env CAP parsed each sleep — fine, document that changes take effect next sleep.
8. **R8 (LOW — NEW)**: clearSummaryDirtyAfterBuild fires AFTER the child-link loop finishes, but if a fresh child write happens DURING the loop's network gap (no network gap actually — all synchronous SQLite) — N/A. Loop is synchronous, no race.
9. **R9 (LOW — NEW from R1)**: SAVEPOINT vs BEGIN — fixed to SAVEPOINT for nested-tx compatibility.

## Out of scope (deferred)

- Manual `hippo rebuild` CLI command
- Orphan summary reaper (zero-child summaries linger)
- Level-3 entity profiles (E5)
- Recall freshness boost using last_rebuilt_at (E4)
- Cross-process advisory locking on sleep
- Bulk rebuild backfill for hosts with pre-E3 dirty backlog (no pre-E3 host has dirty rows; the column existed but stayed 0)

## Ship pattern

Stacked PR off `feat-dag-e2-dirty-propagation`. PR #68 expected. Per gh-cascade memory: plain `gh pr merge 67 --rebase` on E2 merge (NO --delete-branch).

No publish at end of E3 — bundled at end of E5 per Keith's "one bundled release v1.12.12" pick.
