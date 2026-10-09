// A store other than hippo.db for the EntryWrites group: it copies memories and tombstones out of hippo.db once, keeps them in
// memory and writes what hippo.db writes, with only what hippo-memory/server exports, so a conformance test shows that is enough.
import { closeHippoDb, openHippoDb } from '../../src/db.js';
import { selectAllEntries } from '../../src/store/entry-reads.js';
import {
  BadRequestError, ConflictError, entryAfterOutcome, NotFoundError, ownScopeTouches, rejectionDigest, RejectedValueError,
  type AppendAuditOpts, type EntryTarget, type EntryWrite, type EntryWrites, type HippoStore, type MemoryEntry, type RawArchive,
} from '../../src/server.js';
import { inMemoryKeyAuditStore } from './in-memory-key-audit-store.js';
import type { StoreSide } from './store-conformance.js';

interface Tombstone {
  readonly reason: string | null;
  readonly rejectedAt: string;
}

export interface ArchivedRow {
  readonly memoryId: string;
  readonly archivedAt: string;
  readonly reason: string;
  readonly archivedBy: string;
}

export interface InMemoryEntryWritesStore extends StoreSide {
  readonly store: HippoStore & { readonly entryWrites: EntryWrites };
  readonly archived: () => readonly ArchivedRow[];
  readonly forgotten: () => number;
  /** writeEntry with `companion` run on the staged write before it commits; `rememberAt` is where the entry's audit rows start. A throw drops the write. */
  readonly writeWith: (write: EntryWrite, companion: (tx: Tx, rememberAt: number) => void) => Promise<void>;
  /** archiveRaw with `companion` run as the archive commits. */
  readonly archiveWith: (archive: RawArchive, companion: () => void) => Promise<string>;
}

/** One write's rows and audit rows, staged so a throw drops both, as a rolled-back transaction would. */
export interface Tx {
  readonly rows: Map<string, MemoryEntry>;
  readonly audit: AppendAuditOpts[];
}

interface CopiedRows {
  readonly memories: Map<string, MemoryEntry>;
  readonly tombstones: Map<string, Tombstone>;
}

const tombstoneKey = (tenantId: string, digest: string): string => `${tenantId}\u0000${digest}`;

function copyRows(hippoRoot: string): CopiedRows {
  const db = openHippoDb(hippoRoot);
  try {
    const memories = new Map(selectAllEntries(db).map((entry): [string, MemoryEntry] => [entry.id, entry]));
    // SAFETY: the SELECT names these four columns.
    const rows = db.prepare('SELECT tenant_id, digest, reason, rejected_at FROM rejected_values').all() as {
      tenant_id: string; digest: string; reason: string | null; rejected_at: string;
    }[];
    const tombstones = new Map(rows.map((r): [string, Tombstone] => [tombstoneKey(r.tenant_id, r.digest), { reason: r.reason, rejectedAt: r.rejected_at }]));
    return { memories, tombstones };
  } finally {
    closeHippoDb(db);
  }
}

/** As hippo.db: a level 2 or 3 summary of the same tenant, live and clean, flips to dirty with one audit row. */
function markParentDirty(tx: Tx, parentId: string, tenantId: string, actor: string): void {
  const parent = tx.rows.get(parentId);
  if (!parent || parent.tenantId !== tenantId || (parent.dag_level !== 2 && parent.dag_level !== 3)) return;
  if ((parent.summary_dirty ?? 0) !== 0 || parent.kind === 'archived') return;
  tx.rows.set(parentId, { ...parent, summary_dirty: 1 });
  tx.audit.push({ tenantId, actor, op: 'summary_marked_dirty', targetId: parentId, metadata: { dag_level: parent.dag_level, source: 'E2' } });
}

function inReach(tx: Tx, target: EntryTarget, id: string): MemoryEntry {
  const row = tx.rows.get(id);
  if (!row || row.tenantId !== target.tenantId || !ownScopeTouches(target.ownScope, row.scope)) {
    throw new NotFoundError(`memory not found: ${id}`);
  }
  return row;
}

export function inMemoryEntryWritesStore(hippoRoot: string): InMemoryEntryWritesStore {
  const base = inMemoryKeyAuditStore(hippoRoot);
  const copied = copyRows(hippoRoot);
  const { tombstones } = copied;
  let memories = copied.memories;
  const archived: ArchivedRow[] = [];
  let forgotten = 0;

  /** An id another tenant holds is refused; a same-id write that keeps its content passes a tombstone, one that brings it in is refused. */
  const put = (tx: Tx, entry: MemoryEntry, actor: string): void => {
    const stored = tx.rows.get(entry.id);
    if (stored && stored.tenantId !== entry.tenantId) throw new ConflictError(`Memory ${entry.id} belongs to another tenant`);
    const digest = rejectionDigest(entry.content);
    const tombstone = tombstones.get(tombstoneKey(entry.tenantId, digest));
    const keepsContent = stored !== undefined && rejectionDigest(stored.content) === digest;
    if (tombstone && !keepsContent) {
      throw new RejectedValueError({ digest, tenantId: entry.tenantId, entryId: entry.id, reason: tombstone.reason, rejectedAt: tombstone.rejectedAt });
    }
    tx.rows.set(entry.id, { ...structuredClone(entry), origin_project: entry.origin_project ?? null, summary_dirty: stored?.summary_dirty ?? 0 });
    tx.audit.push({ tenantId: entry.tenantId, actor, op: 'remember', targetId: entry.id, metadata: { kind: entry.kind ?? 'distilled', scope: entry.scope ?? null } });
    if (entry.dag_parent_id) markParentDirty(tx, entry.dag_parent_id, entry.tenantId, actor);
  };

  /** Commits the rows and audit rows only when fn returns; a refusal still gets its row, written after the drop. */
  const inTx = async <T>(actor: string, fn: (tx: Tx) => T): Promise<T> => {
    const tx: Tx = { rows: new Map(memories), audit: [] };
    let result: T;
    try {
      result = fn(tx);
    } catch (err) {
      if (err instanceof RejectedValueError) {
        await base.store.appendAuditEvents([{
          tenantId: err.tenantId, actor, op: 'reject_refusal', targetId: err.entryId, metadata: { digest: err.digest, reason: err.reason },
        }]);
      }
      throw err;
    }
    memories = tx.rows;
    await base.store.appendAuditEvents(tx.audit);
    return result;
  };

  const writeWith: InMemoryEntryWritesStore['writeWith'] = async ({ entry, actor }, companion) => {
    await inTx(actor, (tx) => {
      const rememberAt = tx.audit.length;
      put(tx, entry, actor);
      companion(tx, rememberAt);
    });
  };

  const archiveWith: InMemoryEntryWritesStore['archiveWith'] = async (archive, companion) => {
    const archivedAt = await inTx(archive.actor, (tx) => {
      const row = inReach(tx, archive, archive.id);
      if (row.kind !== 'raw') throw new BadRequestError(`memory ${archive.id} is not raw (kind=${row.kind})`);
      const at = new Date().toISOString();
      tx.rows.delete(archive.id);
      tx.audit.push({ tenantId: row.tenantId, actor: archive.actor, op: 'archive_raw', targetId: archive.id, metadata: { reason: archive.reason } });
      if (row.dag_parent_id) markParentDirty(tx, row.dag_parent_id, row.tenantId, archive.actor);
      companion();
      return at;
    });
    archived.push({ memoryId: archive.id, archivedAt, reason: archive.reason, archivedBy: archive.actor });
    forgotten += 1;
    return archivedAt;
  };

  const entryWrites: EntryWrites = {
    writeEntry: (write) => writeWith(write, () => undefined),
    async applyOutcome({ tenantId, actor, ownScope, ids, good }) {
      return inTx(actor, (tx) => {
        const applied: string[] = [];
        for (const id of ids) {
          const row = tx.rows.get(id);
          if (!row || row.tenantId !== tenantId || !ownScopeTouches(ownScope, row.scope)) continue;
          put(tx, entryAfterOutcome(row, good), actor);
          tx.audit.push({ tenantId, actor, op: 'outcome', targetId: id, metadata: { good } });
          applied.push(id);
        }
        return applied;
      });
    },
    async supersede(write) {
      const { tenantId, actor, oldId, successor } = write;
      await inTx(actor, (tx) => {
        const old = inReach(tx, write, oldId);
        if ((old.superseded_by ?? null) !== null) throw new ConflictError(`Memory ${oldId} already superseded by another writer`);
        tx.rows.set(oldId, { ...old, superseded_by: successor.id });
        if (old.dag_parent_id) markParentDirty(tx, old.dag_parent_id, tenantId, actor);
        put(tx, successor, actor);
        tx.audit.push({ tenantId, actor, op: 'supersede', targetId: oldId, metadata: { newId: successor.id } });
      });
    },
    archiveRaw: (archive) => archiveWith(archive, () => undefined),
    async forget(removal) {
      await inTx(removal.actor, (tx) => {
        const row = inReach(tx, removal, removal.id);
        // hippo.db's trigger message, so the dashboard and CLI match it the same way under either store.
        if (row.kind === 'raw') throw new Error('raw is append-only');
        tx.rows.delete(removal.id);
        tx.audit.push({ tenantId: row.tenantId, actor: removal.actor, op: 'forget', targetId: removal.id });
        if (row.dag_parent_id) markParentDirty(tx, row.dag_parent_id, row.tenantId, removal.actor);
      });
      forgotten += 1;
    },
  };

  const store: InMemoryEntryWritesStore['store'] = {
    ...base.store,
    async entriesByIds(ids, tenantId) {
      const wanted = new Set(ids.slice(0, 500));
      const rows = [...memories.values()].filter((e) => wanted.has(e.id) && (tenantId === undefined || e.tenantId === tenantId));
      const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
      return structuredClone(rows.sort((a, b) => cmp(a.created, b.created) || cmp(a.content, b.content) || cmp(a.id, b.id)));
    },
    entryWrites,
  };
  return { store, auditRows: base.auditRows, archived: () => structuredClone(archived), forgotten: () => forgotten, writeWith, archiveWith };
}
