// A store other than hippo.db for the Rejections group, built on the in-memory entry-writes store: it copies the tombstones out
// of hippo.db once and removes rows from the memories that store holds, with store-kit and the two text rules in src/core.
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { mergedSuccessor } from '../../src/core/merged-row.js';
import { rejectedText } from '../../src/core/rejection-text.js';
import {
  heldTexts,
  normalizeValueForRejection,
  ownScopeTouches,
  rejectionDigest,
  type AppliedRejection,
  type HippoStore,
  type MemoryEntry,
  type RejectedValueRow,
  type Rejection,
  type Rejections,
} from '../../src/entry/store-kit.js';
import {
  inMemoryEntryWritesStore,
  markParentDirty,
  tombstoneKey,
  type InMemoryEntryWritesStore,
  type Tx,
} from './in-memory-entry-writes-store.js';
import type { StoreSide } from './store-conformance.js';

export interface InMemoryRejectionsStore extends StoreSide {
  readonly store: HippoStore & { readonly rejections: Rejections };
}

const TOMBSTONES_SQL = `SELECT tenant_id AS tenantId, digest, reason, rejected_by AS rejectedBy, rejected_at AS rejectedAt,
  source_memory_id AS sourceMemoryId, normalized_chars AS normalizedChars FROM rejected_values`;

function copyTombstones(hippoRoot: string): RejectedValueRow[] {
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: the SELECT names each RejectedValueRow field.
    return db.prepare(TOMBSTONES_SQL).all() as RejectedValueRow[];
  } finally {
    closeHippoDb(db);
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const newestFirst = (a: RejectedValueRow, b: RejectedValueRow): number =>
  cmp(b.rejectedAt, a.rejectedAt) || cmp(a.digest, b.digest);
const byCreated = (a: MemoryEntry, b: MemoryEntry): number => cmp(a.created, b.created) || cmp(a.id, b.id);

/** As hippo.db: a raw row is archived, any other deleted with no forget row, and a merged row gives way to its successor. */
function removeHolders(
  tx: Tx,
  rejection: Rejection,
  holds: (text: string) => boolean,
): Omit<AppliedRejection, 'digest' | 'content'> {
  const { tenantId, actor, reason } = rejection;
  const rows = [...tx.rows.values()]
    .filter((e) => e.tenantId === tenantId && ownScopeTouches(rejection.ownScope, e.scope ?? null))
    .sort(byCreated);
  const direct = rows.filter((e) => holds(e.content));
  const merged = rows.filter((e) => !holds(e.content) && heldTexts(e).some(holds));
  const removedIds: string[] = [];
  const removedRawIds: string[] = [];
  const successorIds: string[] = [];
  const remove = (row: MemoryEntry): void => {
    tx.rows.delete(row.id);
    if (row.dagParentId) markParentDirty(tx, row.dagParentId, tenantId, actor);
  };
  for (const row of direct) {
    if (row.kind === 'raw') {
      tx.audit.push({ tenantId, actor, op: 'archive_raw', targetId: row.id, metadata: { reason } });
      removedRawIds.push(row.id);
    }
    remove(row);
    removedIds.push(row.id);
  }
  for (const row of merged) {
    const successor = mergedSuccessor(row, holds, new Set(removedIds));
    remove(row);
    removedIds.push(row.id);
    if (!successor) continue;
    tx.rows.set(successor.id, { ...structuredClone(successor), summaryDirty: false });
    tx.audit.push({
      tenantId: successor.tenantId,
      actor,
      op: 'remember',
      targetId: successor.id,
      metadata: { kind: successor.kind ?? 'distilled', scope: successor.scope ?? null },
    });
    successorIds.push(successor.id);
  }
  return { removedIds, removedRawIds, successorIds, dormantSuccessorIds: [] };
}

function rejectionsOn(base: InMemoryEntryWritesStore, rows: RejectedValueRow[]): Rejections {
  const tenantRows = (tenantId: string): RejectedValueRow[] =>
    rows.filter((r) => r.tenantId === tenantId).sort(newestFirst);
  return {
    async apply(rejection) {
      const { tenantId, actor, reason, memoryId } = rejection;
      const source = memoryId === undefined ? undefined : base.rowById(memoryId);
      const content = rejectedText(
        rejection,
        source && { content: source.content, tenant_id: source.tenantId, scope: source.scope ?? null },
      );
      const digest = rejectionDigest(content);
      const removal = await base.stage(actor, (tx) => {
        const removed = removeHolders(tx, rejection, (text) => rejectionDigest(text) === digest);
        tx.audit.push({
          tenantId,
          actor,
          op: 'reject_value',
          targetId: memoryId,
          metadata: { digest, removedIds: removed.removedIds, count: removed.removedIds.length },
        });
        return removed;
      });
      const rejectedAt = new Date().toISOString();
      rows.push({
        tenantId,
        digest,
        reason,
        rejectedBy: actor,
        rejectedAt,
        sourceMemoryId: memoryId ?? null,
        normalizedChars: normalizeValueForRejection(content).length,
      });
      base.tombstones.set(tombstoneKey(tenantId, digest), { reason, rejectedAt });
      return { digest, content, ...removal };
    },
    async lift(tenantId, digestPrefix, actor) {
      const matches = tenantRows(tenantId).filter((r) => r.digest.startsWith(digestPrefix));
      const target = matches[0];
      if (target === undefined) return { status: 'not_found' };
      if (matches.length > 1) return { status: 'ambiguous', candidates: matches };
      rows.splice(rows.indexOf(target), 1);
      base.tombstones.delete(tombstoneKey(tenantId, target.digest));
      await base.store.appendAuditEvents([
        {
          tenantId,
          actor,
          op: 'unreject_value',
          targetId: target.sourceMemoryId ?? undefined,
          metadata: { digest: target.digest, reason: target.reason },
        },
      ]);
      return { status: 'ok', digest: target.digest, reason: target.reason };
    },
    list: async (tenantId) => structuredClone(tenantRows(tenantId)),
    async refusedAmong(checks) {
      return checks.map(({ tenantId, entryId, content }) => {
        const digest = rejectionDigest(content);
        if (!base.tombstones.has(tombstoneKey(tenantId, digest))) return false;
        const stored = base.rowById(entryId);
        return stored === undefined || stored.tenantId !== tenantId || rejectionDigest(stored.content) !== digest;
      });
    },
  };
}

export function inMemoryRejectionsStore(hippoRoot: string): InMemoryRejectionsStore {
  const base = inMemoryEntryWritesStore(hippoRoot);
  const rejections = rejectionsOn(base, copyTombstones(hippoRoot));
  return { store: { ...base.store, rejections }, auditRows: base.auditRows };
}
