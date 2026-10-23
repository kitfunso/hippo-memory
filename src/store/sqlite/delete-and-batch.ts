import { DEFAULT_TENANT_ID } from '../../base/util/tenant.js';
import { type MemoryEntry } from '../../base/memory/memory.js';
import { RawAppendOnlyError } from '../../base/errors/raw-append-only.js';
import { AUTO_DELETABLE } from './rule-sql.js';
import type { SqlFragment } from '../../db/sql.js';
import { openHippoDb, withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { introducesContent, rejectedValues } from './rejection.js';
import { rejectionDigest } from '../../base/records/rejection-digest.js';
import type { RejectedValueRow } from '../port/rejections.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';
import { insertDormantRow } from './dormant-rows.js';
import { log } from '../../base/util/log.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry } from './rows.js';
import { audit } from './audit-event.js';
import { refusalAudit } from '../rules/audit-rows.js';
import { deleteFtsRow, replaceFtsRows, stampOriginProject, upsertMemoryRow } from './entry-row.js';
import { purgeMirrorBestEffort, writeMarkdownMirrors } from './mirrors.js';
import type { StoreFiles } from './open.js';
import { clock, type WriteBudget } from '../../base/util/write-budget.js';
import { noteFailedUnit } from '../../base/errors/failed-unit.js';
import { chunked, ID_CHUNK } from '../../base/util/chunked.js';
import { placeholders } from '../../db/sql.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import type { FlushComponent, LoadedRows, DormantMove, StrengthRefresh } from '../port/consolidation.js';

/** Tables whose rows keep a first-class object's backing memory in `memory_id` (ON DELETE SET NULL);
 * tests/store/dormant-memories.test.ts pins it to the schema. */
export const MEMORY_BACKED_TABLES = [
  'predictions',
  'decisions',
  'incidents',
  'processes',
  'policies',
  'skills',
  'project_briefs',
  'customer_notes',
] as const;

/** Deleting a memory that backs an object nulls the object's link, and no restore can repair it, so no automatic pass
 * may. */
const AUTOMATIC_DELETE: SqlFragment = {
  sql: `${AUTO_DELETABLE.sql}${MEMORY_BACKED_TABLES.map(
    (t) => ` AND NOT EXISTS (SELECT 1 FROM ${t} WHERE ${t}.memory_id = memories.id)`,
  ).join('')}`,
  params: AUTO_DELETABLE.params,
};

/** The ids among `ids` that back a first-class object, one statement per chunk, for passes that plan deletes before
 * making them. */
export function memoriesBackingAmong(db: DatabaseSyncLike, ids: readonly string[]): Set<string> {
  const backed = new Set<string>();
  if (ids.length === 0) return backed;
  const tables = backingTables(db);
  // The NOT NULL term lets each table's partial memory_id index answer the IN.
  const sql = tables
    .map(
      (t) => `SELECT memory_id FROM ${t} WHERE memory_id IS NOT NULL AND memory_id IN (SELECT value FROM json_each(?))`,
    )
    .join(' UNION ');
  for (const chunk of chunked([...new Set(ids)])) {
    const list = JSON.stringify(chunk);
    // SAFETY: every arm selects memory_id under IS NOT NULL.
    const rows = cachedStatement(db, sql).all(...tables.map(() => list)) as Array<{ memory_id: string }>;
    for (const row of rows) backed.add(row.memory_id);
  }
  return backed;
}

// Quality repair opens an older schema unmigrated, which can lack some of the tables.
function backingTables(db: DatabaseSyncLike): string[] {
  const rows = cachedStatement(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders(MEMORY_BACKED_TABLES.length)})`,
  ).all(...MEMORY_BACKED_TABLES) as Array<{ name: string }>;
  const present = new Set(rows.map((row) => row.name));
  return MEMORY_BACKED_TABLES.filter((table) => present.has(table));
}

// The abort text of trg_memories_raw_append_only (migration v14), the one place src matches it.
const RAW_TRIGGER_TEXT = 'raw is append-only';

function isRawTriggerAbort(cause: unknown): cause is Error {
  return cause instanceof Error && cause.message.includes(RAW_TRIGGER_TEXT);
}

/** Runs the DELETE and returns the rows it removed; the raw-row trigger's abort becomes RawAppendOnlyError. */
function deleteMemoryRow(db: ReturnType<typeof openHippoDb>, sql: string, params: SqlFragment['params']): number {
  try {
    return Number(cachedStatement(db, sql).run(...params).changes ?? 0);
  } catch (cause) {
    throw isRawTriggerAbort(cause) ? new RawAppendOnlyError(cause) : cause;
  }
}

/** db-scoped delete core, composable inside a caller's transaction; NO filesystem I/O, mirrors are written post-commit.
 * `suppressForgetAudit` is set by rejectValue and resolveConflict (own audit row). Returns `{tenantId, dagParentId}`,
 * or null if the tenant holds no such row or `automatic` refused it. */
export function deleteEntryCore(
  db: ReturnType<typeof openHippoDb>,
  id: string,
  tenantId: string,
  opts?: { actor?: string; suppressForgetAudit?: boolean; reason?: string; automatic?: boolean },
): { tenantId: string; dagParentId: string | null } | null {
  const row = cachedStatement(db, `SELECT ${DELETE_TARGET_COLUMNS} FROM memories WHERE id = ? AND tenant_id = ?`).get(
    id,
    tenantId,
  ) as DeleteTarget | undefined;
  return row?.id ? deleteTargetRow(db, row, opts) : null;
}

// SAFETY: every read cast to this row selects DELETE_TARGET_COLUMNS; scripts/check-row-casts.mjs proves it.
interface DeleteTarget {
  id: string;
  tenant_id: string;
  dag_parent_id?: string | null;
}
const DELETE_TARGET_COLUMNS = 'id, tenant_id, dag_parent_id';

function deleteTargetRow(
  db: DatabaseSyncLike,
  row: DeleteTarget,
  opts?: { actor?: string; suppressForgetAudit?: boolean; reason?: string; automatic?: boolean },
): { tenantId: string; dagParentId: string | null } | null {
  const { id, tenant_id: tenantId } = row;
  const guard = opts?.automatic ? AUTOMATIC_DELETE : null;
  // The tenant is in the WHERE so the DELETE itself cannot reach a row the read did not.
  const sql = `DELETE FROM memories WHERE id = ? AND tenant_id = ?${guard ? ` AND ${guard.sql}` : ''}`;
  if (deleteMemoryRow(db, sql, [id, tenantId, ...(guard?.params ?? [])]) === 0) return null;
  deleteFtsRow(db, id);
  if (!opts?.suppressForgetAudit) {
    audit(db, 'forget', {
      targetId: id,
      metadata: opts?.reason ? { reason: opts.reason } : undefined,
      actor: opts?.actor ?? CLI_ACTOR,
      tenantId,
    });
  }
  // Forgetting a child of a summary marks the parent dirty. Not atomic with the DELETE, but markSummaryDirtyInTx is
  // idempotent, so the next child mutation re-marks the parent if this fails.
  if (row.dag_parent_id) {
    markSummaryDirtyInTx(db, row.dag_parent_id, tenantId, opts?.actor ?? CLI_ACTOR);
  }
  return { tenantId, dagParentId: row.dag_parent_id ?? null };
}

/** deleteEntry with `automatic` for each removal and its own forget row and reason. Returns the ids deleted, in
 * `removals` order; a missing, repeated, pinned, raw or object-backing id is left out. */
export function deleteEntriesAutomatically(
  db: DatabaseSyncLike,
  files: StoreFiles,
  removals: readonly { id: string; reason: string }[],
  actor: string,
): string[] {
  const went = deleteEntriesInBatches(db, files, removals, { actor, automatic: true });
  return removals.filter((_, i) => went[i]).map((removal) => removal.id);
}

/** Deletes each target with its own forget row and reason, one transaction per chunk after one read of its ids;
 * `true` where the row went, so a repeated id is true once. A host-wide pass: each row's own tenant goes into its
 * DELETE. */
export function deleteEntriesInBatches(
  db: DatabaseSyncLike,
  { hippoRoot }: StoreFiles,
  targets: readonly { id: string; reason: string }[],
  opts: { actor?: string; automatic?: boolean },
): boolean[] {
  const gone = new Set<string>();
  for (const chunk of chunked(targets)) {
    const deleted = withWriteScope(db, 'delete_entries', () => {
      const rows = selectDeleteTargets(
        db,
        chunk.map((target) => target.id),
      );
      return chunk
        .filter(({ id, reason }) => {
          const row = rows.get(id);
          return row !== undefined && deleteTargetRow(db, row, { ...opts, reason }) !== null;
        })
        .map((target) => target.id);
    });
    for (const id of deleted) {
      gone.add(id);
      purgeMirrorBestEffort(hippoRoot, id, false, 'deleteEntry');
    }
  }
  return targets.map((target) => gone.delete(target.id));
}

function selectDeleteTargets(db: DatabaseSyncLike, ids: readonly string[]): Map<string, DeleteTarget> {
  const rows = new Map<string, DeleteTarget>();
  for (const chunk of chunked([...new Set(ids)])) {
    const found = cachedStatement(
      db,
      `SELECT ${DELETE_TARGET_COLUMNS} FROM memories WHERE id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(chunk)) as Array<DeleteTarget>;
    for (const row of found) rows.set(row.id, row);
  }
  return rows;
}

// The child fields a level-2/3 summary is built from (loadChildrenOfSummary, generateDagSummary).
const SUMMARY_INPUTS = ['content', 'created', 'dagParentId', 'kind'] as const;

function mergeOwnChanges(base: MemoryEntry, ours: MemoryEntry, live: MemoryEntry): MemoryEntry {
  const row: MemoryEntry = { ...live };
  const loaded = new Map(Object.entries(base));
  for (const [key, value] of Object.entries(ours)) {
    if (JSON.stringify(value) !== JSON.stringify(loaded.get(key))) Object.assign(row, { [key]: value });
  }
  return row;
}

/** Writes, deletes and dormant moves in one transaction. With `snapshot`, a write keeps only the fields the caller
 * changed and never resurrects a gone row. Dormant moves (src/store/dormant.ts) leave `memories` like a delete; both
 * skip rows no longer auto-deletable. Returns ids that left `memories`. */
export function batchWriteAndDelete(
  db: DatabaseSyncLike,
  files: StoreFiles,
  toWrite: MemoryEntry[],
  toDeleteIds: string[],
  opts?: { snapshot?: ReadonlyMap<string, MemoryEntry>; dormant?: DormantMove[] },
): string[] {
  // One component, so every op keeps the statement order this call has always had.
  const all: FlushComponent = { refreshes: [], writes: toWrite, deletes: toDeleteIds, dormant: opts?.dormant ?? [] };
  return batchWriteAndDeleteOn(db, files, [all], 0, { snapshot: opts?.snapshot, holdMs: Infinity }).removedIds;
}

/** Tags a flush error with the ids of the component it stopped at, for the partial sleep audit row. */
function noteFailedComponent(err: Error, component: FlushComponent | undefined): void {
  if (!component) return;
  noteFailedUnit(err, [
    ...component.refreshes.map((r) => r.id),
    ...component.writes.map((e) => e.id),
    ...component.deletes,
    ...component.dormant.map((m) => m.entry.id),
  ]);
}

/** batchWriteAndDelete on the caller's open store from component `from`, each component whole, closing the transaction
 * at the first component boundary after `holdMs`. Returns the next component's index and the ids that left `memories`.
 */
function batchWriteAndDeleteOn(
  db: DatabaseSyncLike,
  files: StoreFiles,
  components: readonly FlushComponent[],
  from: number,
  opts: { snapshot?: LoadedRows; holdMs: number; clock?: () => number },
): FlushChunk {
  const now = opts.clock ?? clock;
  const out: ChunkLog = {
    written: [],
    removedIds: [],
    rejectedSkips: 0,
    fts: { rows: [], staleIds: [] },
    dirty: { parents: new Set(), tenantById: new Map() },
  };
  let next = from;
  // IMMEDIATE: the tombstone probes below read before the first write, and under a deferred BEGIN a concurrent `hippo
  // reject` would make the lock upgrade fail with SQLITE_BUSY and roll back the batch.
  withWriteScope(db, 'flush_chunk', () => {
    next = applyUntilHold(db, files, components, { ...opts, from, clock: now }, out);
    const removed = new Set(out.removedIds);
    replaceFtsRows(
      db,
      out.fts.rows.filter((row) => !removed.has(row.id)),
      [...out.fts.staleIds, ...out.removedIds],
    );
    // Fire dirty-mark for every collected parent INSIDE the BEGIN, so the dirty flag commits atomically with the writes
    // and deletes.
    for (const parentId of out.dirty.parents) {
      markSummaryDirtyInTx(db, parentId, out.dirty.tenantById.get(parentId) ?? DEFAULT_TENANT_ID, 'batch');
    }
  });
  reportChunk(files.hippoRoot, out);
  return { next, removedIds: out.removedIds };
}

// A transaction's first window is 16 ops and each next one doubles, so it reads the rows of at most twice the ops it
// applies, plus 16, however early its hold closes it.
const FIRST_WINDOW_OPS = 16;

/** Applies components from `from` until the hold runs out, each window of them planned on one read; the next index. */
function applyUntilHold(
  db: DatabaseSyncLike,
  files: StoreFiles,
  components: readonly FlushComponent[],
  opts: { from: number; snapshot?: LoadedRows; holdMs: number; clock: () => number },
  out: ChunkLog,
): number {
  const begunAt = opts.clock();
  let next = opts.from;
  let window: PlannedWindow | undefined;
  let windowOps = FIRST_WINDOW_OPS;
  do {
    const at = next++;
    try {
      if (window === undefined || at >= window.until) {
        window = planWindow(db, files, components, { from: at, maxOps: windowOps, snapshot: opts.snapshot });
        windowOps = Math.min(windowOps * 2, ID_CHUNK);
      }
      applyComponent(db, components[at]!, window.writes[at - window.from]!, window.refused, out);
    } catch (err) {
      if (err instanceof Error) noteFailedComponent(err, components[at]);
      throw err;
    }
  } while (next < components.length && opts.clock() - begunAt < opts.holdMs);
  return next;
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

/** One component in the open transaction, in the order a single batch always ran: pin-checked deletes, writes, dormant
 * moves, row deletes. */
function applyComponent(
  db: DatabaseSyncLike,
  component: FlushComponent,
  writes: readonly PlannedWrite[],
  refused: ReadonlyMap<string, RejectedValueRow>,
  out: ChunkLog,
): void {
  // Snapshot every doomed row's dag_parent_id before the deletes: consolidation flushes through here every cycle, so
  // without it parents would never be marked dirty for decay, merge or garbage-collect.
  const deletableIds: string[] = [];
  if (component.deletes.length > 0) {
    // A row pinned after the caller decided to delete it survives.
    for (const row of selectAutoDeletableRows(db, component.deletes, out.dirty)) deletableIds.push(row.id);
  }
  applyPlannedWrites(db, writes, refused, out);
  moveDormantAndDelete(db, component.dormant, deletableIds, out);
}

/** A component's writes, one a row: v39 batch writers bypass writeEntry, so store-derived origins are stamped here (a
 * NULL origin hides new memories from ambient context). */
function componentOps(files: StoreFiles, component: FlushComponent): Array<MemoryEntry | StrengthRefresh> {
  // A row queued twice keeps its first place and its last version, the one the merge compares; refreshes come first,
  // so a later write of the same row replaces its refresh.
  const ops = new Map<string, MemoryEntry | StrengthRefresh>(component.refreshes.map((r) => [r.id, r]));
  for (const entry of component.writes) ops.set(entry.id, stampOriginProject(files, entry));
  return [...ops.values()];
}

/** After COMMIT: warn about refused writes, then sync mirrors once for what landed. */
function reportChunk(hippoRoot: string, out: ChunkLog): void {
  if (out.rejectedSkips > 0) {
    log.warn(
      `batchWriteAndDelete: skipped ${out.rejectedSkips} write(s) whose content matches a rejected value (tombstone ` +
        `hit during the batch transaction)`,
    );
  }
  // A skipped write never landed, so mirroring it would resurrect the text the skip kept out of the DB.
  writeMarkdownMirrors(hippoRoot, out.written);
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
  const deleteRow = cachedStatement(db, 'DELETE FROM memories WHERE id = ?');
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

/** The still auto-deletable rows among `ids`, recording each one's DAG parent as dirty. */
function selectAutoDeletableRows(
  db: DatabaseSyncLike,
  ids: readonly string[],
  dirty: DirtyParents,
): Array<{ id: string; dag_parent_id: string | null; tenant_id: string | null }> {
  const rows = cachedStatement(
    db,
    `SELECT id, dag_parent_id, tenant_id FROM memories WHERE id IN (SELECT value FROM json_each(?)) AND ` +
      `${AUTOMATIC_DELETE.sql}`,
  ).all(JSON.stringify(ids), ...AUTOMATIC_DELETE.params) as Array<{
    id: string;
    dag_parent_id: string | null;
    tenant_id: string | null;
  }>;
  for (const row of rows) {
    if (row.dag_parent_id) {
      dirty.parents.add(row.dag_parent_id);
      dirty.tenantById.set(row.dag_parent_id, row.tenant_id ?? DEFAULT_TENANT_ID);
    }
  }
  return rows;
}

/** The row a write lands as: a refresh sets its strength on the live row (none when the row is gone); a full write
 * keeps what others changed since `base` was loaded. */
function batchRow(
  op: MemoryEntry | StrengthRefresh,
  base: MemoryEntry | undefined,
  live: MemoryEntry | undefined,
): MemoryEntry | undefined {
  if (!('content' in op)) return live && { ...live, strength: op.strength };
  return base && live ? mergeOwnChanges(base, op, live) : op;
}

/** The writes of components [from, until), planned on their live rows and tombstones read together. */
interface PlannedWindow {
  readonly from: number;
  readonly until: number;
  readonly writes: readonly (readonly PlannedWrite[])[];
  readonly refused: ReadonlyMap<string, RejectedValueRow>;
}

// Components share no id, and none changes another's rows before the chunk ends, so rows read ahead stay current.
// The probe runs on THIS connection inside the transaction: the producer's check ran earlier on another connection,
// so a reject committed in between would be re-inserted.
function planWindow(
  db: DatabaseSyncLike,
  files: StoreFiles,
  components: readonly FlushComponent[],
  at: { from: number; maxOps: number; snapshot: LoadedRows | undefined },
): PlannedWindow {
  const ops: Array<Array<MemoryEntry | StrengthRefresh>> = [];
  let count = 0;
  for (let i = at.from; i < components.length && (i === at.from || count < at.maxOps); i++) {
    ops.push(componentOps(files, components[i]!));
    count += ops[ops.length - 1]!.length;
  }
  const liveRows = liveRowsById(
    db,
    ops.flat().map((op) => op.id),
  );
  const writes = ops.map((list) => list.flatMap((op) => plannedWrite(op, at.snapshot?.get(op.id), liveRows)));
  return { from: at.from, until: at.from + ops.length, writes, refused: refusedWrites(db, writes.flat()) };
}

function plannedWrite(
  op: MemoryEntry | StrengthRefresh,
  base: MemoryEntry | undefined,
  liveRows: ReadonlyMap<string, MemoryRow>,
): PlannedWrite[] {
  const liveRow = liveRows.get(op.id);
  const live = liveRow ? rowToEntry(liveRow) : undefined;
  const row = batchRow(op, base, live);
  return row ? [{ row, base, live, liveRow }] : [];
}

// A refused write is skipped, never thrown, so the rest lands.
function applyPlannedWrites(
  db: DatabaseSyncLike,
  planned: readonly PlannedWrite[],
  refused: ReadonlyMap<string, RejectedValueRow>,
  out: ChunkLog,
): void {
  for (const { row, base, live } of planned) {
    const tombstone = refused.get(row.id);
    if (tombstone) {
      auditRefusal(db, row, tombstone);
      out.rejectedSkips++;
      continue;
    }
    if (base && !live) continue;
    writeBatchRow(db, row, live, out);
  }
}

/** One write of a batch: the row it lands as, the snapshot row and live row it came from, and the live row's
 * columns. */
interface PlannedWrite {
  readonly row: MemoryEntry;
  readonly base: MemoryEntry | undefined;
  readonly live: MemoryEntry | undefined;
  readonly liveRow: MemoryRow | undefined;
}

/** The rows among `ids`, by id, in chunked IN lists. */
function liveRowsById(db: DatabaseSyncLike, ids: readonly string[]): Map<string, MemoryRow> {
  const rows = new Map<string, MemoryRow>();
  for (const chunk of chunked(ids)) {
    const found = cachedStatement(
      db,
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(chunk)) as MemoryRow[];
    for (const row of found) rows.set(row.id, row);
  }
  return rows;
}

/** The tombstone each refused write matched, by row id, in one read per tenant. checkRejectionGuard's rule, not a bare
 * probe: a live same-content row a tombstone matches still takes decay and replay updates. */
function refusedWrites(db: DatabaseSyncLike, planned: readonly PlannedWrite[]): Map<string, RejectedValueRow> {
  const byTenant = new Map<string, PlannedWrite[]>();
  for (const write of planned) {
    const tenantId = write.row.tenantId ?? DEFAULT_TENANT_ID;
    const writes = byTenant.get(tenantId) ?? [];
    writes.push(write);
    byTenant.set(tenantId, writes);
  }
  const refused = new Map<string, RejectedValueRow>();
  for (const [tenantId, writes] of byTenant) {
    const digests = writes.map((write) => rejectionDigest(write.row.content));
    const tombstones = rejectedValues(db, tenantId, digests);
    writes.forEach((write, i) => {
      const tombstone = tombstones.get(digests[i]!);
      if (tombstone && introducesContent(write.liveRow, tenantId, digests[i]!)) refused.set(write.row.id, tombstone);
    });
  }
  return refused;
}

function auditRefusal(db: DatabaseSyncLike, row: MemoryEntry, tombstone: RejectedValueRow): void {
  const refused = refusalAudit(tombstone.tenantId, 'sleep-batch', row.id, tombstone);
  audit(db, refused.op, refused);
}

/** Lands one batch row with its full-text and dirty-parent bookkeeping. */
function writeBatchRow(db: DatabaseSyncLike, row: MemoryEntry, live: MemoryEntry | undefined, out: ChunkLog): void {
  const { written, fts, dirty } = out;
  written.push(row);
  // Bypass the guard: merges concatenate already-guarded facts, the merge pass checks merged content, and the probe
  // above closes the race; a mid-batch refusal would abort the whole consolidation.
  upsertMemoryRow(db, row);
  // A decay refresh changes no indexed text, and re-indexing it would cost a full index scan per row.
  if (!live || row.content !== live.content || row.tags.join(' ') !== live.tags.join(' ')) {
    fts.rows.push(row);
    if (live) fts.staleIds.push(row.id);
  }
  // Hook for writes: a new child, or a change to what its summary reads, marks the parent dirty; decay alone does
  // not.
  if (row.dagParentId && (!live || SUMMARY_INPUTS.some((k) => row[k] !== live[k]))) {
    dirty.parents.add(row.dagParentId);
    dirty.tenantById.set(row.dagParentId, row.tenantId);
  }
}

/** Full-text rows a batch must insert, and the ids whose old full-text rows it must delete first. */
interface FtsChanges {
  rows: MemoryEntry[];
  staleIds: string[];
}

/** Commits whole components in transactions of about `budget.holdMs`, letting other writers in between; returns the ids
 * that left `memories`. The snapshot keeps what other writers changed after the caller loaded its rows. */
export async function commitInChunks(
  db: DatabaseSyncLike,
  files: StoreFiles,
  components: readonly FlushComponent[],
  opts: { snapshot: LoadedRows; budget: WriteBudget },
): Promise<string[]> {
  const { snapshot, budget } = opts;
  const removed: string[] = [];
  let next = 0;
  try {
    let committedAt = 0;
    while (next < components.length) {
      if (next > 0) await budget.pause(committedAt);
      const chunk = batchWriteAndDeleteOn(db, files, components, next, {
        snapshot,
        holdMs: budget.holdMs,
        clock: budget.clock,
      });
      committedAt = budget.clock();
      next = chunk.next;
      for (const id of chunk.removedIds) removed.push(id);
    }
  } catch (err) {
    // A unit that threw is already tagged; a throw outside one (a pause, BEGIN or COMMIT) names the chunk's first unit.
    if (err instanceof Error) noteFailedComponent(err, components[next]);
    throw err;
  }
  return removed;
}
