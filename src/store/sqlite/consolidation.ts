// hippo.db's Consolidation group: sleep's reads and writes, the DAG summaries, half-life moves and tombstone checks.
import { DAG_LEVEL, type MemoryEntry } from '../../base/memory/memory.js';
import { type DatabaseSyncLike, withWriteScope, getMeta, setMeta, SLEEP_DB_WAIT_MS } from '../../db/index.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import { findRejectedValue } from './rejection.js';
import { rejectionDigest } from '../../base/records/rejection-digest.js';
import { log } from '../../base/util/log.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry } from './rows.js';
import { audit } from './audit-event.js';
import { syncFtsRow, ftsDriftAt } from './entry-row.js';
import { chunked } from '../../base/util/chunked.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { DIGEST_DISPLAY_CHARS } from '../../base/util/token-text.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import { WRITE_BUDGET } from '../../base/util/write-budget.js';
import {
  planHalfLifeMoves,
  type HalfLifeMove,
  type HalfLifeOutcome,
  type HalfLifeRow,
  type HalfLifeRows,
} from '../../base/memory/half-life-plan.js';
import type { RebuildPatch, Consolidation } from '../port/consolidation.js';
import { appendAuditEvent, recordAuditEventsRowByRowAt } from './audit.js';
import { conflictResolveAuditsAt, resolvedConflictsAt, replaceDetectedConflictsAt } from './conflicts.js';
import {
  iterateEveryTenantEntriesAt,
  iterateRowsWithObjectsAt,
  loadDuplicateCandidatesAt,
  loadEntriesPageAt,
  loadEntryIdsPageAt,
  selectEntriesByIds,
} from './entry-reads.js';
import { setHalfLivesAt } from './entry-writes.js';
import { HALF_LIFE_BASE_META_KEY, TYPED_HALF_LIFE_META_KEY, type Handles, waitingOpener } from './open.js';
import { reportAuditWriteFailure } from '../../base/records/audit-report.js';
import { commitInChunksAt, deleteEntriesInBatchesAt, memoriesBackingAmongAt } from './delete-and-batch.js';
import { expireDormantBeforeAt } from './dormant.js';
import { loadPendingExtractionTenantsAt, markPendingProcessedUpToAt } from './graph-queue.js';
import { appendConsolidationRunAt, incrementSleepCountAt, loadSessionDecayContextAt } from './index-and-stats.js';
import { findPromotableSessionsAt, listSessionEventsAt, traceExistsForSessionAt } from './sessions.js';
import { saveStoredParticlesAt, storedParticleIdsAt, storedParticlesByIdsAt } from './vector-index.js';
import { openStore } from './handles.js';
import {
  bound,
  boundAsync,
  boundAsyncWithFiles,
  boundWithFiles,
  skipEmpty,
  type Bodies,
  type FileBodies,
} from './bound.js';
import type { AppendAuditOpts } from '../port/types.js';
import type { Sync } from './served.js';
import { served } from './served.js';
import { cachedStatement } from '../../db/statement-cache.js';

// Sleep-cycle rebuild surface: lives here, not in src/domain/consolidate/dag.ts, because it needs module-private
// MEMORY_SELECT_COLUMNS, MemoryRow, rowToEntry, audit, syncFtsRow and assertTenantId. dag.ts keeps only the thin
// orchestrator rebuildDirtySummaries().

/** Host-wide loader for L2 topic summaries without an L3 parent, for consolidate phase 1.9 (buildEntityProfiles);
 * SQL-level filter, since in-memory `survivors` lacks L2s created by phase 1.7. Entries carry tenantId so per-cluster
 * writes stay tenant-scoped. */
function loadAllL2SummariesAt(db: DatabaseSyncLike): MemoryEntry[] {
  const rows = cachedStatement(
    db,
    `
    SELECT ${MEMORY_SELECT_COLUMNS}
      FROM memories
     WHERE dag_level = ${DAG_LEVEL.topic}
       AND dag_parent_id IS NULL
       AND kind != 'archived'
       AND superseded_by IS NULL
     ORDER BY created ASC, id ASC
  `,
  ).all() as MemoryRow[];
  return rows.map(rowToEntry);
}

/** Dirty summaries across all tenants, newest change first (latest_at DESC NULLS LAST, id ASC), at most `limit` (all
 * when omitted) so HIPPO_DAG_REBUILD_CAP reads only the most recently changed. Each entry carries its tenantId so later
 * writes stay tenant-scoped. */
function loadAllDirtySummariesAt(db: DatabaseSyncLike, limit?: number): MemoryEntry[] {
  const rows = cachedStatement(
    db,
    `
    SELECT ${MEMORY_SELECT_COLUMNS}
      FROM memories
     WHERE summary_dirty = 1
       AND kind != 'archived'
     ORDER BY latest_at DESC NULLS LAST, id ASC
     LIMIT ?
  `,
  ).all(limit ?? -1) as MemoryRow[];
  return rows.map(rowToEntry);
}

/** Live (non-archived) children of a DAG summary, so a rebuild regenerates from the CURRENT child set; tenant-scoped as
 * defence in depth. */
function loadChildrenOfSummaryAt(db: DatabaseSyncLike, summaryId: string, tenantId: string): MemoryEntry[] {
  assertTenantId('loadChildrenOfSummary', tenantId);
  const rows = cachedStatement(
    db,
    `
    SELECT ${MEMORY_SELECT_COLUMNS}
      FROM memories
     WHERE dag_parent_id = ?
       AND tenant_id = ?
       AND kind != 'archived'
       AND superseded_by IS NULL
     ORDER BY created ASC, id ASC
  `,
  ).all(summaryId, tenantId) as MemoryRow[];
  return rows.map(rowToEntry);
}

/** loadChildrenOfSummary for many summaries in one IN query per tenant chunk: one list per summary in the order given,
 * each in created order. */
function childrenOfSummariesAt(
  db: DatabaseSyncLike,
  summaries: ReadonlyArray<{ id: string; tenantId: string }>,
): MemoryEntry[][] {
  const byTenant = new Map<string, string[]>();
  for (const s of summaries) {
    assertTenantId('loadChildrenOfSummaries', s.tenantId);
    const ids = byTenant.get(s.tenantId) ?? [];
    ids.push(s.id);
    byTenant.set(s.tenantId, ids);
  }
  const out = new Map<string, MemoryEntry[]>();
  for (const [tenantId, ids] of byTenant) {
    for (const slice of chunked(ids)) {
      const rows = cachedStatement(
        db,
        `
        SELECT ${MEMORY_SELECT_COLUMNS}
          FROM memories
         WHERE dag_parent_id IN (SELECT value FROM json_each(?))
           AND tenant_id = ?
           AND kind != 'archived'
           AND superseded_by IS NULL
         ORDER BY created ASC, id ASC
      `,
      ).all(JSON.stringify(slice), tenantId) as MemoryRow[];
      for (const entry of rows.map(rowToEntry)) {
        const key = childrenKey(tenantId, entry.dagParentId ?? '');
        const list = out.get(key);
        if (list) list.push(entry);
        else out.set(key, [entry]);
      }
    }
  }
  return summaries.map((summary) => out.get(childrenKey(summary.tenantId, summary.id)) ?? []);
}

/** Key into the map childrenOfSummariesAt reads. */
function childrenKey(tenantId: string, summaryId: string): string {
  return `${tenantId}\u0000${summaryId}`;
}

/** Apply a rebuild result to a dirty summary in one write scope (UPDATE plus syncFtsRow); `AND summary_dirty = 1` makes
 * a concurrent race-loser a no-op. Returns `{ changed, refused }`: `refused` only when a tombstone hit suppressed the
 * content write while the metadata UPDATE still landed. */
function applyRebuildResultAt(db: DatabaseSyncLike, summary: MemoryEntry, patch: RebuildPatch) {
  assertTenantId('applyRebuildResult', summary.tenantId);
  return withWriteScope(db, 'rebuild_summary', () => applyRebuildInSavepoint(db, summary, patch));
}

// ONE prepared UPDATE per branch. Test #8 inspects the SQL string.
const REBUILD_CONTENT_SQL = `UPDATE memories
              SET content = ?,
                  descendant_count = ?,
                  earliest_at = ?,
                  latest_at = ?,
                  last_rebuilt_at = ?,
                  rebuild_count = COALESCE(rebuild_count, 0) + 1,
                  summary_dirty = 0
            WHERE id = ?
              AND tenant_id = ?
              AND dag_level IN (${DAG_LEVEL.topic}, ${DAG_LEVEL.entity})
              AND summary_dirty = 1
              AND kind != 'archived'`;
const REBUILD_METADATA_SQL = `UPDATE memories
              SET descendant_count = ?,
                  earliest_at = ?,
                  latest_at = ?,
                  summary_dirty = 0
            WHERE id = ?
              AND tenant_id = ?
              AND dag_level IN (${DAG_LEVEL.topic}, ${DAG_LEVEL.entity})
              AND summary_dirty = 1
              AND kind != 'archived'`;

function applyRebuildInSavepoint(db: DatabaseSyncLike, summary: MemoryEntry, patch: RebuildPatch) {
  const nowIso = new Date().toISOString();

  // Check tombstones before choosing the UPDATE: this direct UPDATE bypasses upsertEntryRow's guard, and a
  // deterministic rebuild would otherwise re-assert a rejected value every sleep cycle.
  const tombstone = patch.bumpRebuildCount
    ? findRejectedValue(db, summary.tenantId, rejectionDigest(patch.content))
    : null;
  // On a tombstone hit, write no content: take the zero-child metadata-only path
  // (descendant_count/earliest_at/latest_at, summary_dirty cleared, no rebuild_count bump). Clearing dirty is
  // deliberate: leaving it set would make every later sleep re-attempt and re-refuse the same rebuild forever.
  const applyContentWrite = patch.bumpRebuildCount && !tombstone;

  const result = applyContentWrite
    ? cachedStatement(db, REBUILD_CONTENT_SQL).run(
        patch.content,
        patch.descendantCount,
        patch.earliestAt,
        patch.latestAt,
        nowIso,
        summary.id,
        summary.tenantId,
      )
    : cachedStatement(db, REBUILD_METADATA_SQL).run(
        patch.descendantCount,
        patch.earliestAt,
        patch.latestAt,
        summary.id,
        summary.tenantId,
      );

  // `changed` means THIS call's UPDATE hit a row, so a refusal still settles the cycle (false would retry the doomed
  // rebuild forever); `refused` lets the caller count it as refused rather than rebuilt.
  const changed = (result.changes ?? 0) > 0;
  const refused = Boolean(tombstone) && changed;

  if (tombstone && changed) auditRefusedRebuild(db, summary, patch, tombstone);

  if (changed) syncRebuiltSummary(db, summary, patch, applyContentWrite, nowIso);
  return { changed, refused };
}

/** Audit and log a rebuild whose content matched a rejected value; metadata still landed. */
function auditRefusedRebuild(
  db: DatabaseSyncLike,
  summary: MemoryEntry,
  patch: RebuildPatch,
  tombstone: NonNullable<ReturnType<typeof findRejectedValue>>,
): void {
  // refused === true here (narrowed for the tombstone.* access). Best-effort refusal audit written INLINE in this
  // still-open SAVEPOINT (the metadata UPDATE already committed to it), so a direct audit() call is correct, not the
  // post-rollback auditRejectionRefusal.
  audit(db, 'reject_refusal', {
    targetId: summary.id,
    metadata: { digest: tombstone.digest, reason: tombstone.reason },
    actor: patch.actor,
    tenantId: summary.tenantId,
  });
  log.warn(
    `applyRebuildResult: refused rebuild content for ${summary.id} — matches a rejected value ` +
      `(digest ${tombstone.digest.slice(0, DIGEST_DISPLAY_CHARS)}...); metadata updated, content unchanged`,
  );
}

function syncRebuiltSummary(
  db: DatabaseSyncLike,
  summary: MemoryEntry,
  patch: RebuildPatch,
  applyContentWrite: boolean,
  nowIso: string,
): void {
  // A bare UPDATE on memories does NOT update memories_fts, so resync from the patched entry; content stays
  // summary.content when the write was refused, since FTS must mirror the row.
  const patchedEntry: MemoryEntry = {
    ...summary,
    content: applyContentWrite ? patch.content : summary.content,
    descendantCount: patch.descendantCount,
    earliestAt: patch.earliestAt,
    latestAt: patch.latestAt,
    summaryDirty: false,
    lastRebuiltAt: applyContentWrite ? nowIso : summary.lastRebuiltAt,
    rebuildCount: applyContentWrite ? (summary.rebuildCount ?? 0) + 1 : summary.rebuildCount,
  };
  syncFtsRow(db, patchedEntry);

  audit(db, 'summary_rebuilt', {
    targetId: summary.id,
    metadata: {
      // Actual level from the summary in scope, never hardcoded: L2 -> 2, L3 -> 3.
      dag_level: summary.dagLevel,
      source: 'E3-rebuild',
      zero_children: patch.zeroChildren,
      descendant_count: patch.descendantCount,
    },
    actor: patch.actor,
    tenantId: summary.tenantId,
  });
}

/** Clear summary_dirty on a new summary after buildDag's child-link loop (each member's writeEntry marks the parent
 * dirty, so the same cycle would rebuild it). Idempotent (no-op, no audit if not dirty); audit source='buildDag-clean'
 * distinguishes it from the rebuild's. */
function clearSummaryDirtyAfterBuildAt(
  db: DatabaseSyncLike,
  summaryId: string,
  tenantId: string,
  actor: string = CLI_ACTOR,
  source: string = 'buildDag-clean',
): void {
  assertTenantId('clearSummaryDirtyAfterBuild', tenantId);
  // RETURNING dag_level reads the actual level so audit metadata stays accurate without an extra SELECT.
  const result = cachedStatement(
    db,
    `
    UPDATE memories
       SET summary_dirty = 0
     WHERE id = ?
       AND tenant_id = ?
       AND dag_level IN (${DAG_LEVEL.topic}, ${DAG_LEVEL.entity})
       AND summary_dirty = 1
       AND kind != 'archived'
    RETURNING dag_level
  `,
  ).get(summaryId, tenantId) as { dag_level: number } | undefined;
  if (result) {
    // source tells buildDag-clean (L2) from buildEntityProfiles-clean (L3) and any future build path.
    audit(db, 'summary_marked_clean', {
      targetId: summaryId,
      metadata: { dag_level: result.dag_level, source },
      actor,
      tenantId,
    });
  }
}

// A half-life move reads, writes, audits and records its base on one handle, so it commits whole or not at all.
/** The base every store used before the base was recorded. */
const LEGACY_HALF_LIFE_BASE = 7;

/** The base this store's memories are on: 7 days when none was ever recorded. */
function recordedHalfLifeBaseAt(db: DatabaseSyncLike): number {
  const raw = Number(getMeta(db, HALF_LIFE_BASE_META_KEY, String(LEGACY_HALF_LIFE_BASE)));
  return Number.isFinite(raw) && raw > 0 ? raw : LEGACY_HALF_LIFE_BASE;
}

function readRows(db: DatabaseSyncLike, from: number, typedPending: boolean): HalfLifeRows {
  return {
    from,
    typedPending,
    conflictAudits: typedPending ? conflictResolveAuditsAt(db) : [],
    resolvedConflicts: typedPending ? resolvedConflictsAt(db) : [],
    rows: typedPending ? iterateRowsWithObjectsAt(db) : withoutObjects(iterateEveryTenantEntriesAt(db)),
  };
}

function* withoutObjects(entries: Iterable<MemoryEntry>): Generator<HalfLifeRow> {
  for (const entry of entries) yield { entry, object: null };
}

/** Writes the move, then one audit event per tenant with each id's old half-life, so the move can be undone. */
function writeMove(db: DatabaseSyncLike, move: HalfLifeMove, actor: string): void {
  setHalfLivesAt(
    db,
    move.entries.map((e) => ({ id: e.id, halfLifeDays: e.halfLifeDays })),
  );
  const byTenant = new Map<string, Record<string, number>>();
  for (const e of move.entries) {
    // One record per tenant, filled in place: copying it per row made the write grow with the square of the store.
    let record = byTenant.get(e.tenantId);
    if (!record) byTenant.set(e.tenantId, (record = {}));
    record[e.id] = e.oldHalfLifeDays;
  }
  for (const [tenantId, oldHalfLives] of byTenant) {
    appendAuditEvent(db, {
      tenantId,
      actor,
      op: 'half_life_migrate',
      metadata: { from: move.from, to: move.to, ids: Object.keys(oldHalfLives), oldHalfLives },
    });
  }
}

/** Moves the store's half-lives to base `to` as planned from the rows read here, then records the base. `outcome` is
 * null when no move is due; a dry run plans and writes nothing. */
function moveHalfLivesAt(
  db: DatabaseSyncLike,
  to: number,
  opts: { dryRun: boolean; actor: string },
): { from: number; outcome: HalfLifeOutcome | null } {
  const run = () => {
    const from = recordedHalfLifeBaseAt(db);
    const typedPending = getMeta(db, TYPED_HALF_LIFE_META_KEY, '') === '';
    if (!(Number.isFinite(to) && to > 0) || (from === to && !typedPending)) return { from, outcome: null };
    const { moves, outcome } = planHalfLifeMoves(readRows(db, from, typedPending), to);
    if (opts.dryRun) return { from, outcome };

    for (const move of moves) writeMove(db, move, opts.actor);
    setMeta(db, HALF_LIFE_BASE_META_KEY, String(to));
    setMeta(db, TYPED_HALF_LIFE_META_KEY, '1');
    return { from, outcome };
  };
  // Plan, write, audit and record the base under one write lock, so a concurrent write or sleep cannot interleave.
  return opts.dryRun ? run() : withWriteScope(db, 'migrate_half_life', run);
}

// The wait is sleep's own, not a server request's 250 ms.
const sleepOpener = waitingOpener(SLEEP_DB_WAIT_MS);
const sleepStoreOpener = waitingOpener(SLEEP_DB_WAIT_MS, openStore);

/** Writes each row in its own scope, logging each one that failed; returns how many failed. */
function auditEachRowAt(db: DatabaseSyncLike, events: readonly AppendAuditOpts[]): number {
  const failed = recordAuditEventsRowByRowAt(db, events);
  for (const { event, error } of failed) reportAuditWriteFailure(event.op, error, event.targetId);
  return failed.length;
}

/** The chunked writers yield between chunks, so the synchronous form keeps them async. */
type Chunked = 'commitFlush' | 'expireDormant';

/** hippo.db's Consolidation group as the synchronous store holds it. */
export type SqliteConsolidation = Sync<Omit<Consolidation, Chunked>> & Pick<Consolidation, Chunked>;

type StoreReads =
  | 'entryIdsPage'
  | 'entriesByIds'
  | 'sessionDecayContext'
  | 'moveHalfLives'
  | 'promotableSessions'
  | 'traceExists'
  | 'sessionEvents'
  | 'countSleep'
  | 'entriesPage'
  | 'duplicateCandidates';
type StoreWrites = 'replaceConflicts' | 'recordRun' | 'deleteInBatches';
type BareRows = Exclude<keyof Consolidation, Chunked | StoreReads | StoreWrites | keyof SummaryOps>;

const storeReadsAt: Bodies<Pick<Consolidation, StoreReads>> = {
  entryIdsPage: (db, page) => loadEntryIdsPageAt(db, ALL_TENANTS, page),
  entriesByIds: (db, ids) => selectEntriesByIds(db, ids, ALL_TENANTS),
  sessionDecayContext: loadSessionDecayContextAt,
  moveHalfLives: moveHalfLivesAt,
  promotableSessions: findPromotableSessionsAt,
  traceExists: traceExistsForSessionAt,
  sessionEvents: listSessionEventsAt,
  countSleep: incrementSleepCountAt,
  entriesPage: (db, page) => loadEntriesPageAt(db, ALL_TENANTS, page),
  duplicateCandidates: loadDuplicateCandidatesAt,
};

const storeWritesAt: FileBodies<Pick<Consolidation, StoreWrites>> = {
  replaceConflicts: replaceDetectedConflictsAt,
  recordRun: appendConsolidationRunAt,
  deleteInBatches: deleteEntriesInBatchesAt,
};

const bareRowsAt: Bodies<Pick<Consolidation, BareRows>> = {
  objectBackedAmong: memoriesBackingAmongAt,
  ftsDrift: ftsDriftAt,
  rejectedValue: findRejectedValue,
  halfLifeBase: recordedHalfLifeBaseAt,
  particleIds: storedParticleIdsAt,
  particlesByIds: storedParticlesByIdsAt,
  saveParticles: saveStoredParticlesAt,
  auditEachRow: auditEachRowAt,
  dirtyGraphTenants: loadPendingExtractionTenantsAt,
  markGraphDrained: markPendingProcessedUpToAt,
};

const summariesAt: Bodies<SummaryOps> = {
  dirtySummaries: loadAllDirtySummariesAt,
  childrenOfSummary: loadChildrenOfSummaryAt,
  childrenOfSummaries: childrenOfSummariesAt,
  applyRebuild: applyRebuildResultAt,
  clearSummaryDirty: clearSummaryDirtyAfterBuildAt,
  unprofiledTopicSummaries: loadAllL2SummariesAt,
};

/** The chunked writers on the store's own clock and pause, under sleep's own lock wait. */
function chunkedWriters({ onAsync }: Handles): Pick<Consolidation, Chunked> {
  const { commitFlush } = boundAsyncWithFiles<Pick<Consolidation, 'commitFlush'>>(
    onAsync,
    {
      commitFlush: (db, files, components, { snapshot, holdMs }) =>
        commitInChunksAt(db, files, components, { snapshot, budget: { ...WRITE_BUDGET, holdMs } }),
    },
    sleepStoreOpener,
  );
  const { expireDormant } = boundAsync<Pick<Consolidation, 'expireDormant'>>(
    onAsync,
    {
      expireDormant: (db, cutoffIso, { dryRun, holdMs }) =>
        expireDormantBeforeAt(db, cutoffIso, { dryRun, budget: { ...WRITE_BUDGET, holdMs } }),
    },
    sleepOpener,
  );
  return { commitFlush: skipEmpty(commitFlush, async () => []), expireDormant };
}

/** Sleep's store work on its hippo.db, each call on its own short-lived handle; an empty batch opens none. */
export function sqliteConsolidation(handles: Handles): SqliteConsolidation {
  const { on } = handles;
  const reads = bound(on, storeReadsAt, openStore);
  const writes = boundWithFiles(on, storeWritesAt, openStore);
  const bare = bound(on, bareRowsAt);
  return {
    ...reads,
    ...writes,
    ...bare,
    ...bound(on, summariesAt, openStore),
    entriesByIds: skipEmpty(reads.entriesByIds, () => new Map()),
    particlesByIds: skipEmpty(bare.particlesByIds, () => []),
    deleteInBatches: skipEmpty(writes.deleteInBatches, () => []),
    objectBackedAmong: skipEmpty(bare.objectBackedAmong, () => new Set<string>()),
    ...chunkedWriters(handles),
  };
}

/** The synchronous group as the port serves it: the chunked writers answer through their own Promises already. */
export function servedConsolidation(sync: SqliteConsolidation): Consolidation {
  const { commitFlush, expireDormant } = sync;
  return { ...served<Omit<Consolidation, Chunked>>(sync), commitFlush, expireDormant };
}

type SummaryOps = Pick<
  Consolidation,
  | 'dirtySummaries'
  | 'childrenOfSummary'
  | 'childrenOfSummaries'
  | 'applyRebuild'
  | 'clearSummaryDirty'
  | 'unprofiledTopicSummaries'
>;
