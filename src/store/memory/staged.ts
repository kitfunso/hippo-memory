// A staged write on the memories: a copy of the rows and the audit rows to append, committed together only when the
// write returns, as one hippo.db transaction would be; with the rules every memory write applies to a row it puts.
import {
  BadRequestError,
  CrossTenantIdError,
  NotFoundError,
  RejectedValueError,
} from '../../base/errors/api-errors.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import { rejectionDigest } from '../../base/records/rejection-digest.js';
import { readerReaches, targetReader } from '../../base/scope/recall-scope.js';
import type { EntryTarget, RawArchive } from '../port/entry-writes.js';
import type { AppendAuditOpts } from '../port/types.js';
import { appendAudit, bumpCounter, hippoDbNow, tenantKey } from './rows.js';
import { asStored } from './stored-entry.js';
import type { ArchivedRow, MemoryTables } from './tables.js';
import { dropOrphanVectors } from './vectors.js';

/** One write's rows and audit rows, staged so a throw drops both, as a rolled-back transaction would. */
export interface Tx {
  readonly rows: Map<string, MemoryEntry>;
  readonly audit: AppendAuditOpts[];
}

/** The audit row a refused value leaves, as hippo.db writes it beside the refusal. */
export function refusalEvent(err: RejectedValueError, actor: string): AppendAuditOpts {
  const metadata = { digest: err.digest, reason: err.reason };
  return { tenantId: err.tenantId, actor, op: 'reject_refusal', targetId: err.entryId, metadata };
}

/** A row with the columns hippo.db's UPDATEs set without stamping updated_at blanked, so other changes show. */
const stampedColumns = (e: MemoryEntry): string =>
  JSON.stringify({
    ...e,
    retrievalCount: 0,
    lastRetrieved: '',
    halfLifeDays: 0,
    strength: 0,
    source: '',
    supersededBy: null,
    scope: null,
    kind: '',
    summaryDirty: false,
  });

/** Stamps updated_at on each new row and each rewritten one, as an upsert does; an UPDATE of only the blanked
 * columns leaves it, as hippo.db's do. */
function stampUpdates(t: MemoryTables, next: ReadonlyMap<string, MemoryEntry>): void {
  const now = hippoDbNow();
  for (const [id, row] of next) {
    const before = t.entries.get(id);
    if (before === row) continue;
    const upserted =
      before === undefined ||
      JSON.stringify(before) === JSON.stringify(row) ||
      stampedColumns(before) !== stampedColumns(row);
    if (upserted) t.updatedAt.set(id, now);
  }
  for (const id of t.updatedAt.keys()) if (!next.has(id)) t.updatedAt.delete(id);
}

/** Runs `fn` on a staged copy and commits it with its audit rows only when it returns; a refusal still gets its row,
 * written after the drop. */
export function stage<T>(t: MemoryTables, actor: string, fn: (tx: Tx) => T): T {
  const tx: Tx = { rows: new Map(t.entries), audit: [] };
  let result: T;
  try {
    result = fn(tx);
  } catch (err) {
    if (err instanceof RejectedValueError) appendAudit(t, [refusalEvent(err, actor)]);
    throw err;
  }
  stampUpdates(t, tx.rows);
  t.entries = tx.rows;
  appendAudit(t, tx.audit);
  dropOrphanVectors(t);
  return result;
}

/** As hippo.db: a level 2 or 3 summary of the same tenant, live and clean, flips to dirty with one audit row. */
export function markParentDirty(tx: Tx, parentId: string, tenantId: string, actor: string): void {
  const parent = tx.rows.get(parentId);
  if (!parent || parent.tenantId !== tenantId || (parent.dagLevel !== 2 && parent.dagLevel !== 3)) return;
  if (parent.summaryDirty === true || parent.kind === 'archived') return;
  tx.rows.set(parentId, { ...parent, summaryDirty: true });
  const metadata = { dag_level: parent.dagLevel, source: 'E2' };
  tx.audit.push({ tenantId, actor, op: 'summary_marked_dirty', targetId: parentId, metadata });
}

/** The row `id` when the target's tenant holds it in a scope the target may reach; NotFoundError otherwise. */
export function inReach(tx: Tx, target: EntryTarget, id: string): MemoryEntry {
  const row = tx.rows.get(id);
  if (!row || row.tenantId !== target.tenantId || !readerReaches(targetReader(target), row.scope)) {
    throw new NotFoundError(`memory not found: ${id}`);
  }
  return row;
}

/** The tombstone that refuses `entry`, unless the row it replaces already holds the same value. */
function refusal(t: MemoryTables, stored: MemoryEntry | undefined, entry: MemoryEntry): RejectedValueError | null {
  const digest = rejectionDigest(entry.content);
  const tombstone = t.rejected.get(tenantKey(entry.tenantId, digest));
  if (!tombstone || (stored !== undefined && rejectionDigest(stored.content) === digest)) return null;
  const { reason, rejectedAt } = tombstone;
  return new RejectedValueError({ digest, tenantId: entry.tenantId, entryId: entry.id, reason, rejectedAt });
}

/** An id another tenant holds is refused, and so is a value a tombstone names; the row lands with its remember row. */
export function put(t: MemoryTables, tx: Tx, entry: MemoryEntry, actor: string): void {
  const stored = tx.rows.get(entry.id);
  if (stored && stored.tenantId !== entry.tenantId) {
    throw new CrossTenantIdError(entry.id);
  }
  const refused = refusal(t, stored, entry);
  if (refused) throw refused;
  tx.rows.set(entry.id, asStored(structuredClone(entry), stored));
  const metadata = { kind: entry.kind ?? 'distilled', scope: entry.scope ?? null };
  tx.audit.push({ tenantId: entry.tenantId, actor, op: 'remember', targetId: entry.id, metadata });
  if (entry.dagParentId) markParentDirty(tx, entry.dagParentId, entry.tenantId, actor);
}

/** Moves a raw row out of the memories with its archive_raw row; any other kind is refused. */
export function archiveRow(tx: Tx, row: MemoryEntry, by: Pick<RawArchive, 'actor' | 'reason'>): ArchivedRow {
  if (row.kind !== 'raw') throw new BadRequestError(`memory ${row.id} is not raw (kind=${row.kind})`);
  const { actor, reason } = by;
  tx.rows.delete(row.id);
  tx.audit.push({ tenantId: row.tenantId, actor, op: 'archive_raw', targetId: row.id, metadata: { reason } });
  if (row.dagParentId) markParentDirty(tx, row.dagParentId, row.tenantId, actor);
  return { memoryId: row.id, archivedAt: new Date().toISOString(), reason, archivedBy: actor };
}

/** `archive` run as a staged write: the archive row lands, and the row counts as forgotten, only once it commits. */
export function archiveOne(t: MemoryTables, archive: RawArchive, companion: () => void): string {
  const row = stage(t, archive.actor, (tx) => {
    const done = archiveRow(tx, inReach(tx, archive, archive.id), archive);
    companion();
    return done;
  });
  t.rawArchive.push(row);
  bumpCounter(t, 'total_forgotten', 1);
  return row.archivedAt;
}
