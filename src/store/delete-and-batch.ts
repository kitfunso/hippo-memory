import { type MemoryEntry } from '../core/memory.js';
import { AUTO_DELETABLE_SQL } from './rule-sql.js';
import { openHippoDb, closeHippoDb, withWriteScope, type DatabaseSyncLike } from '../db/index.js';
import { checkRejectionGuard, RejectedValueError } from './rejection.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';
import { type DormantMove, insertDormantRow } from './dormant.js';
import { log } from '../util/log.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry } from './rows.js';
import { audit } from './audit-event.js';
import { deleteFtsRow, replaceFtsRows, stampOriginProject, upsertMemoryRow } from './entry-row.js';
import { purgeMirrorBestEffort, mirrorBestEffort, writeMarkdownMirror } from './mirrors.js';
import { openStore } from './open.js';
import { clock, type WriteBudget } from '../util/write-budget.js';

/** Tables whose rows keep a first-class object's backing memory in `memory_id` (ON DELETE SET NULL); tests/dormant-memories.test.ts pins it to the schema. */
export const MEMORY_BACKED_TABLES = ['predictions', 'decisions', 'incidents', 'processes', 'policies', 'skills', 'project_briefs', 'customer_notes'] as const;

/** Deleting a memory that backs an object nulls the object's link, and no restore can repair it, so no automatic pass may. */
const AUTOMATIC_DELETE_SQL = `${AUTO_DELETABLE_SQL}${MEMORY_BACKED_TABLES.map((t) => ` AND NOT EXISTS (SELECT 1 FROM ${t} WHERE ${t}.memory_id = memories.id)`).join('')}`;

/** Ids of memories that back a first-class object, for passes that plan deletes before making them. A table missing from an older schema is skipped. */
export function memoriesBackingObjects(hippoRoot: string): Set<string> {
  const db = openHippoDb(hippoRoot);
  try {
    return memoriesBackingObjectsOn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** memoriesBackingObjects on the caller's handle. */
export function memoriesBackingObjectsOn(db: DatabaseSyncLike): Set<string> {
  const ids = new Set<string>();
  for (const table of MEMORY_BACKED_TABLES) {
    try {
      // SAFETY: SELECT of one nullable TEXT column, filtered to non-null.
      const rows = db.prepare(`SELECT memory_id FROM ${table} WHERE memory_id IS NOT NULL`).all() as { memory_id: string }[];
      for (const r of rows) ids.add(r.memory_id);
    } catch (err) {
      // A missing table is an older schema; any other error could hide a backing memory, so the caller stops.
      if (!(err instanceof Error && err.message.includes('no such table'))) throw err;
    }
  }
  return ids;
}

/**
 * db-scoped delete core, so a delete can compose inside a caller's transaction.
 * NO filesystem I/O: the caller's transaction may still roll back, and mirrors are written post-commit.
 *
 * `opts.suppressForgetAudit` (default false): `rejectValue` and `resolveConflict` set it because each
 * writes its own aggregate audit row, so a removed row must not ALSO emit a `forget` row.
 *
 * Returns `{tenantId, dagParentId}` for the removed row, or `null` if no row with `id`
 * existed or `automatic` refused it (pinned, raw, kept for good or backing an object at DELETE time, so a late pin wins).
 */
export function deleteEntryCore(
  db: ReturnType<typeof openHippoDb>,
  id: string,
  opts?: { actor?: string; suppressForgetAudit?: boolean; reason?: string; automatic?: boolean },
): { tenantId: string; dagParentId: string | null } | null {
  // SAFETY: row's shape matches the three columns named in the SELECT above.
  const row = db
    .prepare(`SELECT id, tenant_id, dag_parent_id FROM memories WHERE id = ?`)
    .get(id) as { id?: string; tenant_id?: string; dag_parent_id?: string | null } | undefined;
  if (!row?.id) return null;

  const guard = opts?.automatic ? ` AND ${AUTOMATIC_DELETE_SQL}` : '';
  if (Number(db.prepare(`DELETE FROM memories WHERE id = ?${guard}`).run(id).changes ?? 0) === 0) return null;
  deleteFtsRow(db, id);
  if (!opts?.suppressForgetAudit) {
    audit(db, 'forget', { targetId: id, metadata: opts?.reason ? { reason: opts.reason } : undefined, actor: opts?.actor ?? 'cli', tenantId: row.tenant_id });
  }
  // Forgetting a child of a summary marks the parent dirty. Not atomic with the DELETE, but
  // markSummaryDirtyInTx is idempotent, so the next child mutation re-marks the parent if this fails.
  if (row.dag_parent_id) {
    markSummaryDirtyInTx(db, row.dag_parent_id, row.tenant_id ?? 'default', opts?.actor ?? 'cli');
  }
  return { tenantId: row.tenant_id ?? 'default', dagParentId: row.dag_parent_id ?? null };
}

/**
 * Delete an entry from SQLite and mirrors.
 *
 * `opts.actor` defaults to 'cli'. The api.* layer threads `ctx.actor` so HTTP
 * callers land with `api_key:<key_id>` in the audit log without a duplicate
 * emit from the api wrapper.
 *
 * Thin wrapper over `deleteEntryCore` (open → core → mirrors → close);
 * behavior is byte-identical to the pre-split implementation for every
 * existing caller.
 */
export function deleteEntry(
  hippoRoot: string,
  id: string,
  opts?: { actor?: string; reason?: string; automatic?: boolean },
): boolean {
  const db = openStore(hippoRoot);
  try {
    return deleteEntryOn(db, hippoRoot, id, opts);
  } finally {
    closeHippoDb(db);
  }
}

/** deleteEntry on the caller's open store, so a loop of deletes opens the store once; each delete still commits alone. */
function deleteEntryOn(
  db: DatabaseSyncLike,
  hippoRoot: string,
  id: string,
  opts?: { actor?: string; reason?: string; automatic?: boolean },
): boolean {
  const result = withWriteScope(db, 'delete_entry', () => deleteEntryCore(db, id, opts));
  if (!result) return false;

  purgeMirrorBestEffort(hippoRoot, id, false, 'deleteEntry');
  return true;
}

// The child fields a level-2/3 summary is built from (loadChildrenOfSummary, generateDagSummary).
const SUMMARY_INPUTS = ['content', 'created', 'dag_parent_id', 'kind'] as const;

function mergeOwnChanges(base: MemoryEntry, ours: MemoryEntry, live: MemoryEntry): MemoryEntry {
  const row: MemoryEntry = { ...live };
  const loaded = new Map(Object.entries(base));
  for (const [key, value] of Object.entries(ours)) {
    if (JSON.stringify(value) !== JSON.stringify(loaded.get(key))) Object.assign(row, { [key]: value });
  }
  return row;
}

/** Writes, deletes and dormant moves in one transaction. With `snapshot` (rows as the caller loaded them), a write keeps only
 *  the fields the caller changed, takes the rest from the live row, and never resurrects a row that is gone.
 *
 *  `dormant` (src/store/dormant.ts): each move's snapshot is inserted into `dormant_memories` and its `memories` row
 *  leaves exactly like a delete (FTS row, DAG parent dirty-mark, mirrors), in the same transaction, so a memory
 *  is never in both places or in neither. Deletes and moves both skip rows that are no longer auto-deletable
 *  (pinned, raw, kept for good or backing an object since the caller decided). Returns the ids that left `memories`, deleted or moved. */
export function batchWriteAndDelete(
  hippoRoot: string,
  toWrite: MemoryEntry[],
  toDeleteIds: string[],
  opts?: { snapshot?: ReadonlyMap<string, MemoryEntry>; dormant?: DormantMove[] },
): string[] {
  const dormant = opts?.dormant ?? [];
  if (toWrite.length === 0 && toDeleteIds.length === 0 && dormant.length === 0) return [];

  const db = openStore(hippoRoot);
  try {
    // One component, so every op keeps the statement order this call has always had.
    const all: FlushComponent = { writes: toWrite, deletes: toDeleteIds, dormant };
    return batchWriteAndDeleteOn(db, hippoRoot, [all], 0, { snapshot: opts?.snapshot, holdMs: Infinity }).removedIds;
  } finally {
    closeHippoDb(db);
  }
}

/** Ops that must commit in one transaction, so a flush split across several never lands part of one. */
export interface FlushComponent {
  writes: readonly MemoryEntry[];
  deletes: readonly string[];
  dormant: readonly DormantMove[];
}

const failedUnits = new WeakMap<Error, string[]>();

/** Tags a flush error with the ids of the component it stopped at, for the partial sleep audit row; the first tag wins. */
function noteFailedUnit(err: Error, component: FlushComponent | undefined): void {
  if (!component || failedUnits.has(err)) return;
  const ids = [...component.writes.map((e) => e.id), ...component.deletes, ...component.dormant.map((m) => m.entry.id)];
  failedUnits.set(err, [...new Set(ids)]);
}

/** The ids noteFailedUnit tagged `err` with, if a flush threw it. */
export function failedUnitOf(err: Error | null): string[] | undefined {
  return err ? failedUnits.get(err) : undefined;
}

/** batchWriteAndDelete on the caller's open store from component `from`, each component whole, closing the transaction at the
 *  first component boundary after `holdMs`. Returns the next component's index and the ids that left `memories`. */
function batchWriteAndDeleteOn(
  db: DatabaseSyncLike,
  hippoRoot: string,
  components: readonly FlushComponent[],
  from: number,
  opts: { snapshot?: ReadonlyMap<string, MemoryEntry>; holdMs: number; clock?: () => number },
): FlushChunk {
  const now = opts.clock ?? clock;
  const out: ChunkLog = { written: [], removedIds: [], rejectedSkips: 0, fts: { rows: [], staleIds: [] }, dirty: { parents: new Set(), tenantById: new Map() } };
  let next = from;
  // IMMEDIATE: the tombstone probes below read before the first write, and under a deferred BEGIN a
  // concurrent `hippo reject` would make the lock upgrade fail with SQLITE_BUSY and roll back the batch.
  withWriteScope(db, 'flush_chunk', () => {
    const begunAt = now();
    do {
      const at = next++;
      try {
        applyComponent(db, hippoRoot, components[at], opts.snapshot, out);
      } catch (err) {
        if (err instanceof Error) noteFailedUnit(err, components[at]);
        throw err;
      }
    } while (next < components.length && now() - begunAt < opts.holdMs);
    const removed = new Set(out.removedIds);
    replaceFtsRows(db, out.fts.rows.filter((row) => !removed.has(row.id)), [...out.fts.staleIds, ...out.removedIds]);
    // Fire dirty-mark for every collected parent INSIDE the BEGIN, so the
    // dirty flag commits atomically with the writes + deletes.
    for (const parentId of out.dirty.parents) {
      markSummaryDirtyInTx(db, parentId, out.dirty.tenantById.get(parentId) ?? 'default', 'batch');
    }
  });
  reportChunk(hippoRoot, out);
  return { next, removedIds: out.removedIds };
}

/** Where the next transaction starts, and the ids this one removed from `memories`. */
interface FlushChunk {
  next: number;
  removedIds: string[];
}

/** What one transaction's components did, for its full-text rows, dirty marks, mirrors and warning. */
interface ChunkLog {
  written: MemoryEntry[];
  removedIds: string[];
  rejectedSkips: number;
  fts: FtsChanges;
  dirty: DirtyParents;
}

/** One component in the open transaction, in the order a single batch always ran: pin-checked deletes, writes, dormant moves, row deletes. */
function applyComponent(
  db: DatabaseSyncLike,
  hippoRoot: string,
  component: FlushComponent,
  snapshot: ReadonlyMap<string, MemoryEntry> | undefined,
  out: ChunkLog,
): void {
  // Snapshot every doomed row's dag_parent_id before the deletes: consolidation flushes through here
  // every cycle, so without it parents would never be marked dirty for decay, merge or garbage-collect.
  const deletableIds: string[] = [];
  if (component.deletes.length > 0) {
    // A row pinned after the caller decided to delete it survives.
    for (const row of selectAutoDeletableRows(db, component.deletes, out.dirty)) deletableIds.push(row.id);
  }
  // v39: batch writers bypass writeEntry, so stamp store-derived origins here too (a NULL origin hides new
  // memories from ambient context). A row queued twice keeps only its last version, the one the merge compares.
  const stampedWrites = [...new Map(component.writes.map((e) => [e.id, stampOriginProject(hippoRoot, e)])).values()];
  applyBatchWrites(db, stampedWrites, snapshot, out);
  moveDormantAndDelete(db, component.dormant, deletableIds, out);
}

/** After COMMIT: warn about refused writes, then sync mirrors once for what landed. */
function reportChunk(hippoRoot: string, out: ChunkLog): void {
  if (out.rejectedSkips > 0) {
    log.warn(
      `batchWriteAndDelete: skipped ${out.rejectedSkips} write(s) whose content matches a rejected value (tombstone hit during the batch transaction)`,
    );
  }
  // A skipped write never landed, so mirroring it would resurrect the text the skip kept out of the DB.
  mirrorBestEffort('markdown mirrors', () => {
    for (const entry of out.written) writeMarkdownMirror(hippoRoot, entry);
  });
  for (const id of out.removedIds) purgeMirrorBestEffort(hippoRoot, id, false, 'batchWriteAndDelete');
}

/** Moves eligible dormant rows out, then deletes them with the doomed rows, recording every removed id. */
function moveDormantAndDelete(
  db: DatabaseSyncLike,
  dormantMoves: readonly DormantMove[],
  deletableIds: string[],
  out: ChunkLog,
): void {
  // Dormant moves: same eligibility and DAG bookkeeping as deletes.
  const movable: DormantMove[] = [];
  if (dormantMoves.length > 0) {
    const byId = new Map(dormantMoves.map((m) => [m.entry.id, m]));
    for (const row of selectAutoDeletableRows(db, [...byId.keys()], out.dirty)) movable.push(byId.get(row.id)!);
  }
  for (const move of movable) {
    insertDormantRow(db, move);
  }
  const deleteRow = db.prepare('DELETE FROM memories WHERE id = ?');
  for (const id of [...deletableIds, ...movable.map((m) => m.entry.id)]) {
    deleteRow.run(id);
    out.removedIds.push(id);
  }
}

/** DAG parents to mark dirty inside the batch transaction, with the tenant each belongs to. */
interface DirtyParents {
  parents: Set<string>;
  tenantById: Map<string, string>;
}

/** The still auto-deletable rows among `ids`, recording each one's DAG parent as dirty. Placeholders come from `ids` itself. */
function selectAutoDeletableRows(
  db: DatabaseSyncLike,
  ids: readonly string[],
  dirty: DirtyParents,
): Array<{ id: string; dag_parent_id: string | null; tenant_id: string | null }> {
  // SAFETY: rows' shape matches the three columns named in the SELECT.
  const rows = db.prepare(
    `SELECT id, dag_parent_id, tenant_id FROM memories WHERE id IN (${ids.map(() => '?').join(',')}) AND ${AUTOMATIC_DELETE_SQL}`,
  ).all(...ids) as Array<{ id: string; dag_parent_id: string | null; tenant_id: string | null }>;
  for (const row of rows) {
    if (row.dag_parent_id) {
      dirty.parents.add(row.dag_parent_id);
      dirty.tenantById.set(row.dag_parent_id, row.tenant_id ?? 'default');
    }
  }
  return rows;
}

function applyBatchWrites(
  db: DatabaseSyncLike,
  stampedWrites: MemoryEntry[],
  snapshot: ReadonlyMap<string, MemoryEntry> | undefined,
  out: ChunkLog,
): void {
  // Probe tombstones per entry on THIS connection inside the transaction: the producer's check ran earlier
  // on another connection, so a reject committed in between would be re-inserted. Skip, never throw, so the rest lands.
  const { written, fts, dirty } = out;
  const readLiveRow = db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id = ?`);
  for (const entry of stampedWrites) {
    const base = snapshot?.get(entry.id);
    // SAFETY: MEMORY_SELECT_COLUMNS is the MemoryRow shape rowToEntry reads.
    const liveRow = readLiveRow.get(entry.id) as MemoryRow | undefined;
    const live = liveRow ? rowToEntry(liveRow) : undefined;
    const row = base && live ? mergeOwnChanges(base, entry, live) : entry;
    if (isRejectedBatchWrite(db, row)) {
      out.rejectedSkips++;
      continue;
    }
    if (base && !live) continue;
    written.push(row);
    // Bypass the guard: merges concatenate already-guarded facts, the merge pass checks merged content, and
    // the probe above closes the race; a mid-batch refusal would abort the whole consolidation.
    upsertMemoryRow(db, row);
    // A decay refresh changes no indexed text, and re-indexing it would cost a full index scan per row.
    if (!live || row.content !== live.content || row.tags.join(' ') !== live.tags.join(' ')) {
      fts.rows.push(row);
      if (live) fts.staleIds.push(row.id);
    }
    // Hook for writes: a new child, or a change to what its summary reads, marks the parent dirty; decay alone does not.
    if (row.dag_parent_id && (!live || SUMMARY_INPUTS.some((k) => row[k] !== live[k]))) {
      dirty.parents.add(row.dag_parent_id);
      dirty.tenantById.set(row.dag_parent_id, row.tenantId);
    }
  }
}

/** Full-text rows a batch must insert, and the ids whose old full-text rows it must delete first. */
interface FtsChanges {
  rows: MemoryEntry[];
  staleIds: string[];
}

/** True, after auditing the refusal, when the write would introduce a rejected value. */
function isRejectedBatchWrite(db: DatabaseSyncLike, row: MemoryEntry): boolean {
  const entryTenantId = row.tenantId ?? 'default';
  // checkRejectionGuard, not a bare tombstone probe: a tombstone can coexist with a live same-content row,
  // and skipping every re-persist would starve it of decay/replay updates; only new or changed content is refused.
  try {
    checkRejectionGuard(db, entryTenantId, row.id, row.content);
  } catch (err) {
    if (err instanceof RejectedValueError) {
      audit(db, 'reject_refusal', { targetId: row.id, metadata: { digest: err.digest, reason: err.reason }, actor: 'sleep-batch', tenantId: entryTenantId });
      return true;
    }
    throw err;
  }
  return false;
}

/** Deletes each target in its own transaction on one store handle; `true` where the row went. */
export function deleteEntriesOneByOne(
  hippoRoot: string,
  targets: readonly { id: string; reason: string }[],
  opts: { actor?: string; automatic?: boolean },
): boolean[] {
  if (targets.length === 0) return [];
  const db = openStore(hippoRoot);
  try {
    return targets.map((target) => deleteEntryOn(db, hippoRoot, target.id, { ...opts, reason: target.reason }));
  } finally {
    closeHippoDb(db);
  }
}

/** Commits whole components in transactions of about `budget.holdMs` on one store handle, letting other writers in between; returns the ids that left `memories`.
 *  The snapshot keeps what other writers changed after the caller loaded its rows. */
export async function commitInChunks(
  hippoRoot: string,
  components: readonly FlushComponent[],
  opts: { snapshot: ReadonlyMap<string, MemoryEntry>; budget: WriteBudget; busyWaitMs: number },
): Promise<string[]> {
  if (components.length === 0) return [];
  const { snapshot, budget } = opts;
  const removed: string[] = [];
  // The wait is an option rather than a PRAGMA, so a shared hook handle keeps its own.
  const db = openStore(hippoRoot, { busyWaitMs: opts.busyWaitMs });
  let next = 0;
  try {
    let committedAt = 0;
    while (next < components.length) {
      if (next > 0) await budget.pause(committedAt);
      const chunk = batchWriteAndDeleteOn(db, hippoRoot, components, next, { snapshot, holdMs: budget.holdMs, clock: budget.clock });
      committedAt = budget.clock();
      next = chunk.next;
      for (const id of chunk.removedIds) removed.push(id);
    }
  } catch (err) {
    // A unit that threw is already tagged; a throw outside one (a pause, BEGIN or COMMIT) names the chunk's first unit.
    if (err instanceof Error) noteFailedUnit(err, components[next]);
    throw err;
  } finally {
    closeHippoDb(db);
  }
  return removed;
}
