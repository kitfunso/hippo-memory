// One window of a batch flush: its writes planned on their live rows and tombstones read together,
// then applied, with the full-text rows and dirty parents the transaction settles.
import { DEFAULT_TENANT_ID } from '../../../base/util/tenant.js';
import type { MemoryEntry } from '../../../base/memory/entry.js';
import { type DatabaseSyncLike } from '../../../db/index.js';
import { introducesContent, rejectedValues } from '../review/rejection.js';
import { rejectionDigest } from '../../../base/records/rejection-digest.js';
import type { RejectedValueRow } from '../../../base/records/rejections.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry } from '../runtime/rows.js';
import { audit } from '../audit/audit-event.js';
import { refusalAudit } from '../../rules/audit-rows.js';
import { stampOriginProject, upsertMemoryRow } from './entry-row.js';
import type { StoreFiles } from '../runtime/open.js';
import { chunked } from '../../../base/util/chunked.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import type {
  FlushComponent,
  LoadedRows,
  StrengthRefresh,
} from '../../../base/records/consolidation.js';

// The child fields a level-2/3 summary is built from (listChildrenOfSummary, generateDagSummary).
const SUMMARY_INPUTS = ['content', 'created', 'dagParentId', 'kind'] as const;

/** The row as loaded, as this write wants it, and as it stands now. */
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

/** What one transaction's components did, for its full-text rows, dirty marks, mirrors
 * and warning. */
export interface ChunkLog {
  written: MemoryEntry[];
  removedIds: string[];
  rejectedSkips: number;
  fts: FtsChanges;
  dirty: DirtyParents;
}

/** A component's writes, one a row: v39 batch writers bypass writeEntry, so store-derived
 * origins are stamped here (a NULL origin hides new memories from ambient context). */
function componentOps(
  files: StoreFiles,
  component: FlushComponent,
): Array<MemoryEntry | StrengthRefresh> {
  // A row queued twice keeps its first place and its last version, the one the merge compares;
  // refreshes come first, so a later write of the same row replaces its refresh.
  const ops = new Map<string, MemoryEntry | StrengthRefresh>(
    component.refreshes.map((r) => [r.id, r]),
  );
  for (const entry of component.writes) ops.set(entry.id, stampOriginProject(files, entry));
  return [...ops.values()];
}

/** DAG parents to mark dirty inside the batch transaction, with the tenant each belongs to. */
export interface DirtyParents {
  parents: Set<string>;
  tenantById: Map<string, string>;
}

/** The row a write lands as: a refresh sets its strength on the live row (none when the row is
 * gone); a full write keeps what others changed since `base` was loaded. */
function batchRow(
  op: MemoryEntry | StrengthRefresh,
  base: MemoryEntry | undefined,
  live: MemoryEntry | undefined,
): MemoryEntry | undefined {
  if (!('content' in op)) return live && { ...live, strength: op.strength };
  return base && live ? mergeOwnChanges({ base, ours: op, live }) : op;
}

/** The writes of components [from, until), planned on their live rows and tombstones
 * read together. */
export interface PlannedWindow {
  readonly from: number;
  readonly until: number;
  readonly writes: readonly (readonly PlannedWrite[])[];
  readonly refused: ReadonlyMap<string, RejectedValueRow>;
}

// Components share no id, and none changes another's rows before the chunk ends, so rows read ahead
// stay current. The probe runs on THIS connection inside the transaction: the producer's check ran
// earlier on another connection, so a reject committed in between would be re-inserted.
export function planWindow(
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

// A refused write is skipped, never thrown, so the rest lands.
export function applyPlannedWrites(
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

/** One write of a batch: the row it lands as, the snapshot row and live row it came from, and
 * the live row's columns. */
export interface PlannedWrite {
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

/** The tombstone each refused write matched, by row id, in one read per tenant.
 * checkRejectionGuard's rule, not a bare probe: a live same-content row a tombstone matches
 * still takes decay and replay updates. */
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
    const digests = writes.map((write) => rejectionDigest(write.row.content));
    const tombstones = rejectedValues(db, tenantId, digests);
    writes.forEach((write, i) => {
      const tombstone = tombstones.get(digests[i]!);
      if (tombstone && introducesContent(write.liveRow, tenantId, digests[i]!)) {
        refused.set(write.row.id, tombstone);
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

/** Lands one batch row with its full-text and dirty-parent bookkeeping. */
function writeBatchRow(
  db: DatabaseSyncLike,
  row: MemoryEntry,
  live: MemoryEntry | undefined,
  out: ChunkLog,
): void {
  const { written, fts, dirty } = out;
  written.push(row);
  // Skip the guard: merges join already-guarded facts, the merge pass checks merged content and the
  // probe above closes the race; a mid-batch refusal would abort the whole consolidation.
  upsertMemoryRow(db, row);
  // A decay refresh changes no indexed text, and re-indexing it would cost a full index scan
  // per row.
  if (!live || row.content !== live.content || row.tags.join(' ') !== live.tags.join(' ')) {
    fts.rows.push(row);
    if (live) fts.staleIds.push(row.id);
  }
  // Hook for writes: a new child, or a change to what its summary reads, marks the parent dirty;
  // decay alone does not.
  if (row.dagParentId && (!live || SUMMARY_INPUTS.some((k) => row[k] !== live[k]))) {
    dirty.parents.add(row.dagParentId);
    dirty.tenantById.set(row.dagParentId, row.tenantId);
  }
}

/** Full-text rows a batch must insert, and the ids whose old full-text rows it must
 * delete first. */
export interface FtsChanges {
  rows: MemoryEntry[];
  staleIds: string[];
}
