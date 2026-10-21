// The in-memory Conflicts group: conflicts listed with both members, resolved as the api decided in one staged write.
import type { MemoryEntry } from '../../base/memory/memory.js';
import { normalizeValueForRejection, rejectionDigest } from '../../base/records/rejection-digest.js';
import { ownScopeTouches } from '../../base/scope/recall-scope.js';
import { keysetPage, type KeysetPosition } from '../../base/util/keyset.js';
import { ALL_TENANTS, type TenantId } from '../../base/util/tenant.js';
import type {
  ConflictListQuery,
  ConflictMember,
  ConflictResolution,
  ConflictRow,
  ConflictRowPage,
  MemoryConflict,
} from '../port/conflicts.js';
import type { Conflicts } from '../port-groups.js';
import { byBytes } from './rows.js';
import { keepTombstone } from './rejections.js';
import { archiveRow, markParentDirty, stage, type Tx } from './staged.js';
import type { MemoryTables } from './tables.js';

const memberOf = (row: MemoryEntry | undefined): ConflictMember | null =>
  row
    ? { scope: row.scope, kind: row.kind, superseded_by: row.supersededBy, origin_project: row.originProject ?? null }
    : null;

/** With a tenant both members must be in it; with none, every conflict comes back with whichever members exist. */
function rowOf(t: MemoryTables, tenantId: TenantId, conflict: MemoryConflict): ConflictRow | null {
  const a = t.entries.get(conflict.memory_a_id);
  const b = t.entries.get(conflict.memory_b_id);
  if (tenantId !== ALL_TENANTS && (a?.tenantId !== tenantId || b?.tenantId !== tenantId)) return null;
  return { conflict: { ...conflict }, a: memberOf(a), b: memberOf(b) };
}

const newestChange = (x: MemoryConflict, y: MemoryConflict): number =>
  byBytes(y.updated_at, x.updated_at) || y.id - x.id;

function isBelow(c: MemoryConflict, after: KeysetPosition): boolean {
  const byKey = byBytes(c.updated_at, String(after.key));
  return byKey < 0 || (byKey === 0 && c.id < Number(after.id));
}

function pageIn(t: MemoryTables, { tenantId, status, limit, after }: ConflictListQuery): ConflictRowPage {
  const hits = t.conflicts
    .filter((c) => (status === '*' || c.status === status) && (!after || isBelow(c, after)))
    .sort(newestChange)
    .flatMap((c) => rowOf(t, tenantId, c) ?? []);
  const page = keysetPage(hits.slice(0, limit + 1), limit, (row) => ({
    key: row.conflict.updated_at,
    id: row.conflict.id,
  }));
  return { rows: page.rows, next: page.next };
}

/** Open conflicts whose members are both in the tenant. */
export function openConflictsIn(t: MemoryTables, tenantId: TenantId): number {
  return t.conflicts.filter((c) => c.status === 'open' && rowOf(t, tenantId, c) !== null).length;
}

/** The conflict is open, names this pair, and each side is still in the tenant under the scope the api read. */
function claimable(tx: Tx, t: MemoryTables, tenantId: string, r: ConflictResolution): MemoryConflict | undefined {
  const holds = (side: { id: string; scope: string | null }): boolean => {
    const row = tx.rows.get(side.id);
    return row !== undefined && row.tenantId === tenantId && row.scope === side.scope;
  };
  const conflict = t.conflicts.find((c) => c.id === r.conflictId && c.status === 'open');
  if (!conflict) return undefined;
  const pair = [conflict.memory_a_id, conflict.memory_b_id].sort().join('\u0000');
  const named = [r.keep.id, r.loser.id].sort().join('\u0000');
  return pair === named && holds(r.keep) && holds(r.loser) ? conflict : undefined;
}

/** What removing the loser did, for the audit row. */
interface Removal {
  removed: boolean;
  raw: boolean;
  digest?: string;
  extra: string[];
}

/** A raw row is archived; any other is deleted with no forget row. */
function removeRow(t: MemoryTables, tx: Tx, row: MemoryEntry, r: ConflictResolution): void {
  if (row.kind === 'raw') {
    t.rawArchive.push(archiveRow(tx, row, { actor: r.actor, reason: r.reason }));
    return;
  }
  tx.rows.delete(row.id);
  if (row.dagParentId) markParentDirty(tx, row.dagParentId, row.tenantId, r.actor);
}

function rejectLoser(t: MemoryTables, tx: Tx, loser: MemoryEntry, r: ConflictResolution, ownScope: string | null) {
  const digest = rejectionDigest(loser.content);
  const normalizedChars = normalizeValueForRejection(loser.content).length;
  const tombstone = { tenantId: loser.tenantId, digest, reason: r.reason, rejectedBy: r.actor, rejectedAt: r.at };
  keepTombstone(t, { ...tombstone, sourceMemoryId: r.loser.id, normalizedChars });
  // Every live same-tenant row holding the value goes, as `hippo reject` does; `keep` stays because the human chose it.
  const dups = [...tx.rows.values()].filter(
    (d) =>
      d.tenantId === loser.tenantId &&
      d.id !== r.loser.id &&
      d.id !== r.keep.id &&
      rejectionDigest(d.content) === digest &&
      ownScopeTouches(ownScope, d.scope),
  );
  for (const dup of dups) removeRow(t, tx, dup, r);
  return { digest, extra: dups.map((d) => d.id) };
}

function settleLoser(t: MemoryTables, tx: Tx, tenantId: string, r: ConflictResolution): Removal {
  const loser = tx.rows.get(r.loser.id)!;
  if (r.fate.kind === 'weaken') {
    const { halfLifeFactor, minHalfLifeDays } = r.fate;
    tx.rows.set(loser.id, { ...loser, halfLifeDays: Math.max(minHalfLifeDays, loser.halfLifeDays * halfLifeFactor) });
    return { removed: false, raw: false, extra: [] };
  }
  const rejected = r.fate.kind === 'reject' ? rejectLoser(t, tx, loser, r, r.fate.ownScope) : undefined;
  removeRow(t, tx, loser, r);
  return { removed: true, raw: loser.kind === 'raw', digest: rejected?.digest, extra: rejected?.extra ?? [] };
}

function dropRef(tx: Tx, tenantId: string, id: string, ref: string): void {
  const row = tx.rows.get(id);
  if (row && row.tenantId === tenantId) {
    tx.rows.set(id, { ...row, conflictsWith: row.conflictsWith.filter((c) => c !== ref) });
  }
}

function resolveIn(t: MemoryTables, tenantId: string, r: ConflictResolution): boolean {
  return stage(t, r.actor, (tx) => {
    const conflict = claimable(tx, t, tenantId, r);
    if (!conflict) return false;
    const out = settleLoser(t, tx, tenantId, r);
    dropRef(tx, tenantId, r.keep.id, r.loser.id);
    if (!out.removed) dropRef(tx, tenantId, r.loser.id, r.keep.id);
    const disposition = out.removed ? (out.raw ? 'archived_raw' : 'deleted') : 'weakened';
    const metadata = {
      conflictId: r.conflictId,
      keepId: r.keep.id,
      loserId: r.loser.id,
      disposition,
      rejected: r.fate.kind === 'reject',
      removedIds: out.removed ? [r.loser.id, ...out.extra] : [],
      rejectedDigest: out.digest,
    };
    tx.audit.push({ tenantId, actor: r.actor, op: 'conflict_resolve', targetId: r.keep.id, metadata });
    t.conflicts[t.conflicts.indexOf(conflict)] = { ...conflict, status: 'resolved', updated_at: r.at };
    return true;
  });
}

export function memoryConflicts(t: MemoryTables): Conflicts {
  return {
    list: async (query) => pageIn(t, query),
    async get(tenantId, conflictId) {
      const conflict = t.conflicts.find((c) => c.id === conflictId);
      return conflict ? rowOf(t, tenantId, conflict) : null;
    },
    resolve: async (tenantId, resolution) => resolveIn(t, tenantId, resolution),
  };
}
