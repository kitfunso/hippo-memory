import { DEFAULT_TENANT_ID } from '../../../base/util/tenant.js';
import type { MemoryEntry } from '../../../base/memory/entry.js';
import { RawAppendOnlyError } from '../../../base/errors/raw-append-only.js';
import { AUTO_DELETABLE } from '../runtime/rule-sql.js';
import type { SqlFragment } from '../../../db/sql.js';
import { withWriteScope, type DatabaseSyncLike } from '../../../db/index.js';
import { introducesContent, rejectedValues } from '../review/rejection.js';
import { rowDigests } from '../../../base/records/rejection-digest.js';
import type { RejectedValueRow } from '../../../base/ports/store/rejections.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';
import { insertDormantRow } from '../dormant/dormant-rows.js';
import { log } from '../../../base/util/log.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry } from '../runtime/rows.js';
import { audit } from '../audit/audit-event.js';
import { refusalAudit } from '../../rules/audit-rows.js';
import { deleteFtsRow, replaceFtsRows, stampOriginProject, upsertMemoryRow } from './entry-row.js';
import { purgeMirrorBestEffort, writeMarkdownMirrors } from '../folder-files/mirrors.js';
import type { StoreFiles } from '../runtime/open.js';
import { clock, type WriteBudget } from '../../../base/util/write-budget.js';
import { noteFailedUnit } from '../../../base/errors/failed-unit.js';
import { chunked, ID_CHUNK } from '../../../base/util/chunked.js';
import { placeholders } from '../../../db/sql.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { deleteMemoryOnlyGraphRows } from '../graph/graph-writes.js';
import { CLI_ACTOR } from '../../../base/scope/actor.js';
import type {
  FlushComponent,
  LoadedRows,
  DormantMove,
  StrengthRefresh,
} from '../../../base/ports/store/consolidation.js';

/** Tables whose rows keep a first-class object's backing memory in `memory_id` (ON DELETE SET
 * NULL); tests/store/dormant-memories.test.ts pins it to the schema. */
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

const AUTOMATIC_DELETE: SqlFragment = {
  sql: `${AUTO_DELETABLE.sql}${MEMORY_BACKED_TABLES.map(
    (t) => ` AND NOT EXISTS (SELECT 1 FROM ${t} WHERE ${t}.memory_id = memories.id)`,
  ).join('')}`,
  params: AUTO_DELETABLE.params,
};

/** The ids among `ids` that back a first-class object, one statement per chunk, for passes that
 * plan deletes before making them. */
export function memoriesBackingAmong(db: DatabaseSyncLike, ids: readonly string[]): Set<string> {
  const backed = new Set<string>();
  if (ids.length === 0) return backed;
  const tables = backingTables(db);
  const sql = tables
    .map(
      (t) =>
        `SELECT memory_id FROM ${t} WHERE memory_id IS NOT NULL AND memory_id IN (SELECT value FROM json_each(?))`,
    )
    .join(' UNION ');
  for (const chunk of chunked([...new Set(ids)])) {
    const list = JSON.stringify(chunk);
    // SAFETY: every arm selects memory_id under IS NOT NULL.
    const rows = cachedStatement(db, sql).all(...tables.map(() => list)) as Array<{
      memory_id: string;
    }>;
    for (const row of rows) backed.add(row.memory_id);
  }
  return backed;
}

function backingTables(db: DatabaseSyncLike): string[] {
  const rows = cachedStatement(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders(MEMORY_BACKED_TABLES.length)})`,
  ).all(...MEMORY_BACKED_TABLES) as Array<{ name: string }>;
  const present = new Set(rows.map((row) => row.name));
  return MEMORY_BACKED_TABLES.filter((table) => present.has(table));
}

const RAW_TRIGGER_TEXT = 'raw is append-only';

function isRawTriggerAbort(cause: unknown): cause is Error {
  return cause instanceof Error && cause.message.includes(RAW_TRIGGER_TEXT);
}

function deleteMemoryRow(db: DatabaseSyncLike, sql: string, params: SqlFragment['params']): number {
  try {
    return Number(cachedStatement(db, sql).run(...params).changes ?? 0);
  } catch (cause) {
    throw isRawTriggerAbort(cause) ? new RawAppendOnlyError(cause) : cause;
  }
}

/** db-scoped delete core, composable inside a caller's transaction; NO filesystem I/O, mirrors
 * are written post-commit. `suppressForgetAudit` is set by rejectValue and resolveConflict (own
 * audit row). Returns `{tenantId, dagParentId}`, or null if the tenant holds no such row or
 * `automatic` refused it. */
export function deleteEntryCore(
  db: DatabaseSyncLike,
  id: string,
  tenantId: string,
  opts?: { actor?: string; suppressForgetAudit?: boolean; reason?: string; automatic?: boolean },
): { tenantId: string; dagParentId: string | null } | null {
  const row = cachedStatement(
    db,
    `SELECT ${DELETE_TARGET_COLUMNS} FROM memories WHERE id = ? AND tenant_id = ?`,
  ).get(id, tenantId) as DeleteTarget | undefined;
  return row?.id ? deleteTargetRow(db, row, opts) : null;
}

// SAFETY: every read cast to this row selects DELETE_TARGET_COLUMNS; scripts/checks/check-row-casts.mjs
// proves it.
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
  const where = `id = ? AND tenant_id = ?${guard ? ` AND ${guard.sql}` : ''}`;
  const params = [id, tenantId, ...(guard?.params ?? [])];
  deleteMemoryOnlyGraphRows(db, { sql: `SELECT id FROM memories WHERE ${where}`, params });
  if (deleteMemoryRow(db, `DELETE FROM memories WHERE ${where}`, params) === 0) return null;
  deleteFtsRow(db, id);
  if (!opts?.suppressForgetAudit) {
    audit(db, 'forget', {
      targetId: id,
      metadata: opts?.reason ? { reason: opts.reason } : undefined,
      actor: opts?.actor ?? CLI_ACTOR,
      tenantId,
    });
  }
  if (row.dag_parent_id) {
    const actor = opts?.actor ?? CLI_ACTOR;
    markSummaryDirtyInTx(db, { summaryId: row.dag_parent_id, tenantId, actor });
  }
  return { tenantId, dagParentId: row.dag_parent_id ?? null };
}

/** Deletes each target with its own forget row and reason, one transaction per chunk after one
 * read of its ids; `true` where the row went, so a repeated id is true once. A host-wide pass:
 * each row's own tenant goes into its DELETE. */
export function deleteEntriesInBatches(
  db: DatabaseSyncLike,
  { hippoRoot }: StoreFiles,
  targets: readonly { id: string; reason: string }[],
  opts: { actor?: string; automatic?: boolean },
): boolean[] {
  const gone = new Set<string>();
  for (const chunk of chunked(targets)) {
    const deleted = withWriteScope(db, 'delete_entries', () => {
      const rows = readDeleteTargets(
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
      purgeMirrorBestEffort(hippoRoot, { id, isRaw: false, logPrefix: 'deleteEntry' });
    }
  }
  return targets.map((target) => gone.delete(target.id));
}

function readDeleteTargets(
  db: DatabaseSyncLike,
  ids: readonly string[],
): Map<string, DeleteTarget> {
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

const SUMMARY_INPUTS = ['content', 'created', 'dagParentId', 'kind'] as const;

interface MergeOwnChangesOptions {
  readonly base: MemoryEntry;
  readonly ours: MemoryEntry;
  readonly live: MemoryEntry;
}

function mergeOwnChanges({ base, ours, live }: MergeOwnChangesOptions): MemoryEntry {
  const row: MemoryEntry = { ...live };
  const loaded = new Map(Object.entries(base));
  for (const [key, value] of Object.entries(ours)) {
    if (JSON.stringify(value) !== JSON.stringify(loaded.get(key))) {
      Object.assign(row, { [key]: value });
    }
  }
  return row;
}

export interface BatchWriteAndDeleteOptions {
  readonly files: StoreFiles;
  readonly toWrite: MemoryEntry[];
  readonly toDeleteIds: string[];
  readonly opts?: { snapshot?: ReadonlyMap<string, MemoryEntry>; dormant?: DormantMove[] };
}

/** Writes, deletes and dormant moves in one transaction. With `snapshot`, a write keeps only the
 * fields the caller changed and never resurrects a gone row. Dormant moves (sqlite/dormant/dormant.ts)
 * leave `memories` like a delete; both skip rows no longer auto-deletable. Returns ids that left
 * `memories`. */
export function batchWriteAndDelete(
  db: DatabaseSyncLike,
  { files, toWrite, toDeleteIds, opts }: BatchWriteAndDeleteOptions,
): string[] {
  const all: FlushComponent = {
    refreshes: [],
    writes: toWrite,
    deletes: toDeleteIds,
    dormant: opts?.dormant ?? [],
  };
  return batchWriteAndDeleteOn(db, {
    files,
    components: [all],
    from: 0,
    opts: { snapshot: opts?.snapshot, holdMs: Infinity },
  }).removedIds;
}

function noteFailedComponent(err: Error, component: FlushComponent | undefined): void {
  if (!component) return;
  noteFailedUnit(err, [
    ...component.refreshes.map((r) => r.id),
    ...component.writes.map((e) => e.id),
    ...component.deletes,
    ...component.dormant.map((m) => m.entry.id),
  ]);
}

interface BatchWriteAndDeleteOnOptions {
  readonly files: StoreFiles;
  readonly components: readonly FlushComponent[];
  readonly from: number;
  readonly opts: { snapshot?: LoadedRows; holdMs: number; clock?: () => number };
}

function batchWriteAndDeleteOn(
  db: DatabaseSyncLike,
  { files, components, from, opts }: BatchWriteAndDeleteOnOptions,
): FlushChunk {
  const now = opts.clock ?? clock;
  const out: ChunkLog = {
    written: [],
    removedIds: [],
    rejectedSkips: 0,
    fts: { rows: [], staleIds: [] },
    dirty: { parents: new Set(), tenantById: new Map() },
  };
  const next = withWriteScope(db, 'flush_chunk', () => {
    const reached = applyUntilHold(db, {
      files,
      components,
      opts: { ...opts, from, clock: now },
      out,
    });
    const removed = new Set(out.removedIds);
    replaceFtsRows(
      db,
      out.fts.rows.filter((row) => !removed.has(row.id)),
      [...out.fts.staleIds, ...out.removedIds],
    );
    for (const parentId of out.dirty.parents) {
      markSummaryDirtyInTx(db, {
        summaryId: parentId,
        tenantId: out.dirty.tenantById.get(parentId) ?? DEFAULT_TENANT_ID,
        actor: 'batch',
      });
    }
    return reached;
  });
  reportChunk(files.hippoRoot, out);
  return { next, removedIds: out.removedIds };
}

const FIRST_WINDOW_OPS = 16;

interface ApplyUntilHoldOptions {
  readonly files: StoreFiles;
  readonly components: readonly FlushComponent[];
  readonly opts: { from: number; snapshot?: LoadedRows; holdMs: number; clock: () => number };
  readonly out: ChunkLog;
}

function applyUntilHold(
  db: DatabaseSyncLike,
  { files, components, opts, out }: ApplyUntilHoldOptions,
): number {
  const begunAt = opts.clock();
  let next = opts.from;
  let window: PlannedWindow | undefined;
  let windowOps = FIRST_WINDOW_OPS;
  do {
    const at = next++;
    try {
      if (window === undefined || at >= window.until) {
        window = planWindow(db, files, components, {
          from: at,
          maxOps: windowOps,
          snapshot: opts.snapshot,
        });
        windowOps = Math.min(windowOps * 2, ID_CHUNK);
      }
      applyComponent(db, {
        component: components[at]!,
        writes: window.writes[at - window.from]!,
        refused: window.refused,
        out,
      });
    } catch (err) {
      if (err instanceof Error) noteFailedComponent(err, components[at]);
      throw err;
    }
  } while (next < components.length && opts.clock() - begunAt < opts.holdMs);
  return next;
}

interface FlushChunk {
  next: number;
  removedIds: string[];
}

interface ChunkLog {
  written: MemoryEntry[];
  removedIds: string[];
  rejectedSkips: number;
  fts: FtsChanges;
  dirty: DirtyParents;
}

interface ApplyComponentOptions {
  readonly component: FlushComponent;
  readonly writes: readonly PlannedWrite[];
  readonly refused: ReadonlyMap<string, RejectedValueRow>;
  readonly out: ChunkLog;
}

function applyComponent(
  db: DatabaseSyncLike,
  { component, writes, refused, out }: ApplyComponentOptions,
): void {
  const deletableIds: string[] = [];
  if (component.deletes.length > 0) {
    for (const row of readAutoDeletableRows(db, component.deletes, out.dirty)) {
      deletableIds.push(row.id);
    }
  }
  applyPlannedWrites(db, writes, refused, out);
  moveDormantAndDelete(db, component.dormant, deletableIds, out);
}

function componentOps(
  files: StoreFiles,
  component: FlushComponent,
): Array<MemoryEntry | StrengthRefresh> {
  const ops = new Map<string, MemoryEntry | StrengthRefresh>(
    component.refreshes.map((r) => [r.id, r]),
  );
  for (const entry of component.writes) ops.set(entry.id, stampOriginProject(files, entry));
  return [...ops.values()];
}

function reportChunk(hippoRoot: string, out: ChunkLog): void {
  if (out.rejectedSkips > 0) {
    log.warn(
      `batchWriteAndDelete: skipped ${out.rejectedSkips} write(s) whose content matches a rejected value (tombstone ` +
        `hit during the batch transaction)`,
    );
  }
  writeMarkdownMirrors(hippoRoot, out.written);
  for (const id of out.removedIds) {
    purgeMirrorBestEffort(hippoRoot, { id, isRaw: false, logPrefix: 'batchWriteAndDelete' });
  }
}

function moveDormantAndDelete(
  db: DatabaseSyncLike,
  dormantMoves: readonly DormantMove[],
  deletableIds: string[],
  out: ChunkLog,
): void {
  const movable: DormantMove[] = [];
  if (dormantMoves.length > 0) {
    const byId = new Map(dormantMoves.map((m) => [m.entry.id, m]));
    for (const row of readAutoDeletableRows(db, [...byId.keys()], out.dirty)) {
      movable.push(byId.get(row.id)!);
    }
  }
  for (const move of movable) {
    insertDormantRow(db, move);
  }
  const doomed = [...deletableIds, ...movable.map((m) => m.entry.id)];
  for (const chunk of chunked(doomed)) {
    const ids = JSON.stringify(chunk);
    deleteMemoryOnlyGraphRows(db, { sql: 'SELECT value FROM json_each(?)', params: [ids] });
    cachedStatement(db, 'DELETE FROM memories WHERE id IN (SELECT value FROM json_each(?))').run(
      ids,
    );
  }
  for (const id of doomed) out.removedIds.push(id);
}

interface DirtyParents {
  parents: Set<string>;
  tenantById: Map<string, string>;
}

function readAutoDeletableRows(
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

function batchRow(
  op: MemoryEntry | StrengthRefresh,
  base: MemoryEntry | undefined,
  live: MemoryEntry | undefined,
): MemoryEntry | undefined {
  if (!('content' in op)) return live && { ...live, strength: op.strength };
  return base && live ? mergeOwnChanges({ base, ours: op, live }) : op;
}

interface PlannedWindow {
  readonly from: number;
  readonly until: number;
  readonly writes: readonly (readonly PlannedWrite[])[];
  readonly refused: ReadonlyMap<string, RejectedValueRow>;
}

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
  const writes = ops.map((list) =>
    list.flatMap((op) => plannedWrite(op, at.snapshot?.get(op.id), liveRows)),
  );
  return {
    from: at.from,
    until: at.from + ops.length,
    writes,
    refused: refusedWrites(db, writes.flat()),
  };
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

interface PlannedWrite {
  readonly row: MemoryEntry;
  readonly base: MemoryEntry | undefined;
  readonly live: MemoryEntry | undefined;
  readonly liveRow: MemoryRow | undefined;
}

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

function refusedWrites(
  db: DatabaseSyncLike,
  planned: readonly PlannedWrite[],
): Map<string, RejectedValueRow> {
  const byTenant = new Map<string, PlannedWrite[]>();
  for (const write of planned) {
    const tenantId = write.row.tenantId ?? DEFAULT_TENANT_ID;
    const writes = byTenant.get(tenantId) ?? [];
    writes.push(write);
    byTenant.set(tenantId, writes);
  }
  const refused = new Map<string, RejectedValueRow>();
  for (const [tenantId, writes] of byTenant) {
    const digests = writes.map((write) => rowDigests(write.row));
    const tombstones = rejectedValues(db, tenantId, digests.flat());
    writes.forEach((write, i) => {
      for (const digest of digests[i]!) {
        const tombstone = tombstones.get(digest);
        if (tombstone && introducesContent(write.liveRow, tenantId, digest)) {
          refused.set(write.row.id, tombstone);
          break;
        }
      }
    });
  }
  return refused;
}

function auditRefusal(db: DatabaseSyncLike, row: MemoryEntry, tombstone: RejectedValueRow): void {
  const target = { tenantId: tombstone.tenantId, actor: 'sleep-batch', targetId: row.id };
  const refused = refusalAudit(target, tombstone);
  audit(db, refused.op, refused);
}

function writeBatchRow(
  db: DatabaseSyncLike,
  row: MemoryEntry,
  live: MemoryEntry | undefined,
  out: ChunkLog,
): void {
  const { written, fts, dirty } = out;
  written.push(row);
  upsertMemoryRow(db, row);
  const textChanged =
    !live ||
    row.content !== live.content ||
    (row.leadIn || null) !== (live.leadIn || null) ||
    row.tags.join(' ') !== live.tags.join(' ');
  if (textChanged) {
    fts.rows.push(row);
    if (live) fts.staleIds.push(row.id);
  }
  if (row.dagParentId && (!live || SUMMARY_INPUTS.some((k) => row[k] !== live[k]))) {
    dirty.parents.add(row.dagParentId);
    dirty.tenantById.set(row.dagParentId, row.tenantId);
  }
}

interface FtsChanges {
  rows: MemoryEntry[];
  staleIds: string[];
}

/** Commits whole components in transactions of about `budget.holdMs`, letting other writers in
 * between; returns the ids that left `memories`. The snapshot keeps what other writers changed
 * after the caller loaded its rows. */
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
      const chunk = batchWriteAndDeleteOn(db, {
        files,
        components,
        from: next,
        opts: {
          snapshot,
          holdMs: budget.holdMs,
          clock: budget.clock,
        },
      });
      committedAt = budget.clock();
      next = chunk.next;
      for (const id of chunk.removedIds) removed.push(id);
    }
  } catch (err) {
    if (err instanceof Error) noteFailedComponent(err, components[next]);
    throw err;
  }
  return removed;
}
