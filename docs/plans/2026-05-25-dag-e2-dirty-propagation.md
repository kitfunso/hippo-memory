# 2026-05-25 — DAG live-coupling E2: child-write dirty-flag propagation

**Status:** Draft v2 (R1 PASS-w/fix-8; 3 plan-text must_fixes folded inline)
**Episode:** 01KSG8G6DYA387KJ9G4N6Y3DJ5
**Branch:** feat-dag-e2-dirty-propagation (off feat-dag-e1-schema-v28; stacked PR — do NOT --delete-branch E1 on merge or this auto-closes)
**Owner:** Claude (Keith review)

## Discover refinement (hoisted per "Discover IS a scope-decision stage" memory)

Brainstorm framing: "wire markSummaryDirty into 4 call sites" — invalidation, writeEntry, forget, archive.

Discover-stage code reads against actual call graph: the 4 trigger paths consolidate to 4 hook insertion points, but with a non-obvious detail that drove a real plan decision:

- **invalidation.ts:97** calls `writeEntry(hippoRoot, entry)` — already covered by the writeEntry hook (1 of 4)
- **writeEntryDbOnly** at `src/store.ts:1169` — single hook covers THREE trigger paths: invalidation (entry has dag_parent_id), supersede-NEW-entry (called from `api.supersede` at `api.ts:1288`), and generic create/update of any child memory
- **`api.supersede` CAS UPDATE** at `api.ts:1277-1280` — NEEDS SEPARATE HOOK because the OLD entry's `superseded_by` mutation does NOT route through writeEntry; the OLD's parent dirty-mark must be inside the supersede SAVEPOINT
- **`deleteEntry` in `src/store.ts`** (the function `api.forget` routes to at `api.ts:1155`) — hook here covers cmdForget + api.forget paths
- **`archiveRawMemory` at `raw-archive.ts:27`** — direct hook; already SELECTs the row (`row.dag_parent_id` accessible)

So the actual scope: **4 hook insertion points**, not 4 named-CLI-commands. Plan critics judge the 4 hook sites.

## Why this exists

E2 of 5-episode DAG live-coupling arc. E1 shipped the persistence shape (PR #66, CI green). E2 fires `markSummaryDirty` on every child mutation so E3's sleep-cycle rebuild has something to act on.

Without E2: `summary_dirty` column exists but stays 0 forever. The DAG layer remains the same inert-text-rows state from before E1. E2 is what makes the live-coupling actually live.

## Goal

Wire `markSummaryDirty` (E1's exported helper) into 4 hook insertion points. Early-exit when child has no `dag_parent_id` (vast majority of writes — preserves writeEntry hot-path perf). All-tenant-safe by passing `entry.tenantId` / `ctx.tenantId` / `row.tenant_id` explicitly.

## Scope

### S1 — Hook 1: `writeEntryDbOnly` in `src/store.ts`

After the DB-only INSERT/UPSERT succeeds (inside the SAVEPOINT, before `RELEASE`), if `entry.dag_parent_id` is set, mark the parent dirty:

```typescript
// In writeEntryDbOnly, after the upsertEntryRow call, before the SAVEPOINT
// RELEASE:
if (entry.dag_parent_id) {
  // E2: child-write propagation. markSummaryDirty is tenant-scoped via E1's
  // WHERE tenant_id=? guard; no cross-tenant leak. Early-exit when null
  // covers the ~99% of writes that are not DAG children.
  markSummaryDirtyInTx(db, entry.dag_parent_id, entry.tenantId, opts.actor ?? 'cli');
}
```

**New helper `markSummaryDirtyInTx`** in `src/store.ts` — accepts an open `db` handle (to participate in the caller's transaction/SAVEPOINT) rather than opening its own connection. Mirrors the existing in-transaction helpers (e.g. the in-savepoint audit emission at `writeEntryDbOnly:1170+`).

Existing `markSummaryDirty(hippoRoot, ...)` (E1) opens its own db. The in-tx variant is a private helper used only by E2's hook sites that already have a db handle.

### S2 — Hook 2: `api.supersede` OLD-entry CAS

In `src/api.ts:1285-1287` — between the CAS-failure rollback guard at L1281-1284 and the `writeEntryDbOnly(NEW)` at L1288. Critical: must land AFTER the rollback guard so a failed CAS hits `throw` before the hook, not after.

```typescript
// E2: OLD entry just transitioned to superseded — its parent (if any) needs
// rebuild. Read old.dag_parent_id from the entry already fetched at L1239.
// Lands strictly between the rollback guard (L1281-1284) and the new entry's
// writeEntryDbOnly (L1288).
if (old.dag_parent_id) {
  markSummaryDirtyInTx(db, old.dag_parent_id, ctx.tenantId, ctx.actor.subject);
}
```

The NEW entry's parent is handled automatically by S1 (writeEntryDbOnly hook fires from L1288).

### S3 — Hook 3: `deleteEntry` in `src/store.ts:1469-1491`

**Correction (R1 must_fix 1+2):** deleteEntry has NO SAVEPOINT — it runs DELETE + deleteFtsRow + removeEntryMirrors + writeIndexMirror + audit as a bare sequence. The dirty-mark hook is therefore **non-atomic with the DELETE** by design (matching deleteEntry's existing audit emission, which is also best-effort).

Degradation: if the dirty-mark UPDATE fails after DELETE commits, the parent doesn't know about the deletion until another child mutation hits the parent's path (eventual consistency). Acceptable since markSummaryDirtyInTx is idempotent + audit is best-effort, mirroring deleteEntry's existing audit-best-effort posture. Wrapping deleteEntry in a SAVEPOINT is scope creep (changes existing call-site semantics for non-DAG deletes); deferred.

**Augment existing SELECT** at `store.ts:1478` rather than adding a new one:

```typescript
// CHANGE: store.ts:1478
//   const row = db.prepare(`SELECT id, tenant_id FROM memories WHERE id = ?`)...
// TO:
const row = db.prepare(`SELECT id, tenant_id, dag_parent_id FROM memories WHERE id = ?`)
  .get(id) as { id: string; tenant_id: string | null; dag_parent_id: string | null } | undefined;
// ... existing DELETE + audit sequence unchanged ...
// AFTER the existing audit emission, before deleteEntry returns:
if (row?.dag_parent_id) {
  markSummaryDirtyInTx(db, row.dag_parent_id, row.tenant_id ?? 'default', opts?.actor ?? 'cli');
}
```

Single SELECT, single row variable reuse, single new hook call. No new query.

### S4 — Hook 4: `archiveRawMemory` in `src/raw-archive.ts`

`raw-archive.ts:28` already does `SELECT * FROM memories WHERE id = ?`. Use `row.dag_parent_id` after the SAVEPOINT body:

```typescript
// In archiveRawMemory, after the DELETE inside the SAVEPOINT, before the
// optional afterArchive hook + RELEASE:
if (row.dag_parent_id) {
  markSummaryDirtyInTx(
    db,
    String(row.dag_parent_id),
    String(row.tenant_id ?? 'default'),
    opts.who || 'cli',
  );
}
```

### S5 — `markSummaryDirtyInTx` helper export

New private helper in `src/store.ts` (mirrors E1's `markSummaryDirty` but takes an open db):

```typescript
/**
 * v0.30 / E2 — in-transaction variant of markSummaryDirty. Takes an open
 * db (caller is responsible for the SAVEPOINT/BEGIN). Used by writeEntryDbOnly
 * + api.supersede CAS + deleteEntry + archiveRawMemory hooks so each child
 * mutation's dirty-mark is atomic with the mutation itself.
 *
 * Same idempotency contract as markSummaryDirty: 0->1 transition only,
 * audit row only on transition, no-op on non-summary / archived / unknown id.
 */
function markSummaryDirtyInTx(
  db: DatabaseSyncLike,
  summaryId: string,
  tenantId: string,
  actor: string,
): void {
  const result = db.prepare(`
    UPDATE memories
       SET summary_dirty = 1
     WHERE id = ?
       AND tenant_id = ?
       AND dag_level = 2
       AND summary_dirty = 0
       AND kind != 'archived'
  `).run(summaryId, tenantId);
  if ((result.changes ?? 0) > 0) {
    audit(db, 'summary_marked_dirty', summaryId, { dag_level: 2, source: 'E2' }, actor, tenantId);
  }
}
```

**No `export` keyword** (private; the public surface stays at E1's `markSummaryDirty`). Confirms AC9.

### S6 — Tests `tests/dag-dirty-propagation.test.ts`

NEW test file. 8 cases per brainstorm matrix + the discover refinement:

1. `writeEntry` on existing fact with dag_parent_id → parent marked dirty. **Explicitly call invalidateMatching() in the test** (not a direct writeEntry) so the invalidation.ts:97 routing is exercised end-to-end, not just the underlying writeEntry hook
2. `api.supersede` on a fact with dag_parent_id → OLD's parent marked dirty AND NEW's parent marked dirty (both fire; same parent, idempotent so audit emits once)
3. `api.forget` on a fact with dag_parent_id → parent marked dirty
4. `archiveRawMemory` on a raw row with dag_parent_id → parent marked dirty
5. `writeEntry` on a fact WITHOUT dag_parent_id → no parent dirty-mark (early-exit verified)
6. Cross-tenant safety: writeEntry of tenant2 child whose dag_parent_id points to tenant1 parent → no dirty-mark (markSummaryDirtyInTx's tenant_id guard rejects)
7. Idempotency: 5 consecutive writeEntry calls on the same child → 1 audit row (parent flag flips once, stays 1)
8. Orphan child (dag_parent_id points to deleted parent) → markSummaryDirtyInTx no-ops; no error thrown

## Acceptance criteria

| # | Criterion | Verifies |
|---|---|---|
| AC1 | writeEntryDbOnly hooks markSummaryDirtyInTx when entry.dag_parent_id is set | S1/S6 #1 |
| AC2 | api.supersede CAS hooks for OLD entry's dag_parent_id inside the SAVEPOINT | S2/S6 #2 |
| AC3 | deleteEntry fetches dag_parent_id pre-DELETE and hooks post-DELETE | S3/S6 #3 |
| AC4 | archiveRawMemory hooks using row.dag_parent_id inside the SAVEPOINT | S4/S6 #4 |
| AC5 | Early-exit when dag_parent_id is null (no perf hit on non-DAG writes) | S1/S6 #5 |
| AC6 | Cross-tenant attack write: child.tenantId mismatched with parent's tenant → no dirty-mark | S6 #6 |
| AC7 | Idempotency: 5 child writes → 1 audit row + parent stays summary_dirty=1 | S6 #7 |
| AC8 | Orphan child (parent deleted): markSummaryDirtyInTx no-ops, no exception | S6 #8 |
| AC9 | `markSummaryDirtyInTx` is private (not exported) | S5 |
| AC10 | metadata.source = 'E2' (distinguishes from E1 'summary_marked_dirty' debug) | S5/S6 |
| AC11 | All existing tests pass (invalidation, supersede, forget, archive paths untouched) | regression |
| AC12 | tsc + build clean | regression |

## Risks

| # | Risk | Lik. | Mitigation |
|---|---|---|---|
| R1 | writeEntryDbOnly hot-path slowdown | L | `if (entry.dag_parent_id)` early-exit. Null check on 99% of writes; only DAG children pay the cost. |
| R2 | Hook fires inside SAVEPOINT but parent SELECT fails (table broken) | L | markSummaryDirtyInTx UPDATE no-ops on 0 rows; audit is best-effort via audit() try/catch. Mutation succeeds. |
| R3 | Stacked PR confusion: E2 branch off E1 (PR #66). E1 merge with --delete-branch would auto-close PR #66+. | M | Memory `feedback-gh-pr-merge-delete-branch-cascade` flagged. Do NOT --delete-branch on E1; merge plain `gh pr merge 66 --rebase`. Only LAST merge of the stack gets --delete-branch. |
| R4 | Idempotency: 5 child writes under same parent → 5 markSummaryDirtyInTx → only 1 audit row (correct) | L | E1's `summary_dirty=0` guard handles. Test #7 locks it. |
| R5 | New unknown audit row leak via 'E2' source string | L | metadata.source is one of the few free-form fields; matches E1 pattern. Already audited by tests. |
| R6 | Recursion risk: markSummaryDirty calls audit(), audit() emits row, row INSERT triggers...? | L | audit_log is an append-only INSERT into a different table; no trigger fires on memories. No recursion. |
| R7 | E1 hasn't merged yet; if E1 plan changes after merge, E2 needs rebase | M | E1 PR #66 is CI-green + ship-ready, only awaiting batch merge. Low rebase risk. |
| R8 | deleteEntry hook non-atomic with DELETE — dirty-mark could fail after DELETE commits | L | Documented in S3 as acceptable degradation. markSummaryDirtyInTx idempotent → next child mutation under same parent re-marks dirty. Mirrors deleteEntry's existing audit best-effort posture. |

## Out of scope

- E3 sleep-cycle rebuildDirtySummaries (consumes the dirty flag this episode sets)
- E4 DAG nodes first-class in recall
- E5 level-3 entity profile build path
- Strength inheritance for summaries (deferred to 6th episode per Keith Q4)
- Performance hardening / soak harness coupling

## Rollback

Single PR, revertible:
- Revert → 4 hook insertion points removed; markSummaryDirtyInTx helper removed; tests deleted
- No DB change; no schema change; no API surface change (helper is private)
- Backward compatible — E1's schema columns still default to 0/null without E2's writes

## Cost estimate

- Coding: ~2-3 hours (4 surgical insertions + 1 private helper + 8 tests)
- Critic rounds: ~1 hour (small surface, R1 should converge)
- Verify: ~10 min
- Total: ~half-day

## Open questions for critics

1. **markSummaryDirtyInTx vs reusing public markSummaryDirty**: the in-tx variant avoids opening a 2nd db handle inside an already-open transaction. Alternative: call public markSummaryDirty which opens its own db — risks deadlock on WAL/SQLITE_BUSY if the caller holds a write lock. In-tx variant is correct; flag if you'd argue otherwise.

2. **metadata.source = 'E2'**: distinguishes audit rows by episode for debugging. Alternative: include trigger name (`invalidate`, `supersede`, `forget`, `archive`) which is more useful for ops. Adds a trigger param to markSummaryDirtyInTx signature. Plan picks the simpler 'E2' string; flag if you'd prefer the trigger param.

3. **Supersede NEW entry double-mark**: api.supersede's writeEntryDbOnly call (L1288) fires S1's hook for the NEW entry's parent (typically same parent as OLD). The S2 hook fires for OLD's parent. Same parent → 2 dirty-mark calls → first transitions 0→1 + audits, second no-ops (idempotency guard). Test #2 covers. Flag if you'd consolidate to one call.

4. **deleteEntry SELECT augmentation**: if deleteEntry already SELECTs for tenant/audit, the v2 plan should be a targeted column add, not a new SELECT. Discover didn't read deleteEntry's body — flag if I should re-read it before plan locks.

5. **Stacked PR review/merge order**: E1 PR #66 must merge BEFORE E2 PR (E2 depends on E1's schema columns + markSummaryDirty helper export). Per the gh-cascade memory: merge E1 with plain `gh pr merge 66 --rebase` (no --delete-branch), then E2 PR re-targets to master automatically. Last episode of the arc gets --delete-branch. Flag if you'd argue for squash-merge of all 5 at end-of-batch instead.
