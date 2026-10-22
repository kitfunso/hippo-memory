// The in-memory Rejections group: a tombstone and the removal of every row holding its value, in one staged write.
import type { MemoryEntry } from '../../base/memory/memory.js';
import { mergedSuccessor } from '../../base/memory/merged-row.js';
import { normalizeValueForRejection, rejectionDigest } from '../../base/records/rejection-digest.js';
import { rejectedText } from '../../base/records/rejection-text.js';
import { ownScopeTouches } from '../../base/scope/recall-scope.js';
import { heldTexts } from '../../base/util/same-text.js';
import type { AppliedRejection, RejectedValueRow, Rejection, Rejections } from '../port/rejections.js';
import { comparing, oldestFirst, REJECTED_ORDER } from '../rules/order.js';
import { appendAudit, tenantKey } from './rows.js';
import { markParentDirty, stage, type Tx } from './staged.js';
import { asStored } from './stored-entry.js';
import type { MemoryTables } from './tables.js';

const newestFirst = comparing(REJECTED_ORDER);

type Removal = Omit<AppliedRejection, 'digest' | 'content'>;

/** A raw row is archived, any other deleted with no forget row, and a merged row gives way to its successor. */
function removeHolders(tx: Tx, rejection: Rejection, holds: (text: string) => boolean): Removal {
  const { tenantId, actor, reason } = rejection;
  const rows = [...tx.rows.values()]
    .filter((e) => e.tenantId === tenantId && ownScopeTouches(rejection.ownScope, e.scope ?? null))
    .sort(oldestFirst);
  const direct = rows.filter((e) => holds(e.content));
  const merged = rows.filter((e) => !holds(e.content) && heldTexts(e).some(holds));
  const removal: Omit<Removal, 'dormantSuccessorIds'> = { removedIds: [], removedRawIds: [], successorIds: [] };
  const remove = (row: MemoryEntry): void => {
    tx.rows.delete(row.id);
    removal.removedIds.push(row.id);
    if (row.dagParentId) markParentDirty(tx, row.dagParentId, tenantId, actor);
  };
  for (const row of direct) {
    if (row.kind === 'raw') {
      tx.audit.push({ tenantId, actor, op: 'archive_raw', targetId: row.id, metadata: { reason } });
      removal.removedRawIds.push(row.id);
    }
    remove(row);
  }
  for (const row of merged) {
    const successor = mergedSuccessor(row, holds, new Set(removal.removedIds));
    remove(row);
    if (!successor) continue;
    tx.rows.set(successor.id, asStored(structuredClone(successor), undefined));
    const metadata = { kind: successor.kind ?? 'distilled', scope: successor.scope ?? null };
    tx.audit.push({ tenantId: successor.tenantId, actor, op: 'remember', targetId: successor.id, metadata });
    removal.successorIds.push(successor.id);
  }
  return { ...removal, dormantSuccessorIds: [] };
}

/** Writes the tombstone, replacing any the tenant holds for the digest. */
export function keepTombstone(t: MemoryTables, row: RejectedValueRow): void {
  t.rejected.set(tenantKey(row.tenantId, row.digest), row);
}

function applyIn(t: MemoryTables, rejection: Rejection): AppliedRejection {
  const { tenantId, actor, reason, memoryId } = rejection;
  const source = memoryId === undefined ? undefined : t.entries.get(memoryId);
  const held = source && { content: source.content, tenant_id: source.tenantId, scope: source.scope ?? null };
  const content = rejectedText(rejection, held);
  const digest = rejectionDigest(content);
  const removal = stage(t, actor, (tx) => {
    const removed = removeHolders(tx, rejection, (text) => rejectionDigest(text) === digest);
    const metadata = { digest, removedIds: removed.removedIds, count: removed.removedIds.length };
    tx.audit.push({ tenantId, actor, op: 'reject_value', targetId: memoryId, metadata });
    return removed;
  });
  const normalizedChars = normalizeValueForRejection(content).length;
  const rejectedAt = new Date().toISOString();
  keepTombstone(t, {
    tenantId,
    digest,
    reason,
    rejectedBy: actor,
    rejectedAt,
    sourceMemoryId: memoryId ?? null,
    normalizedChars,
  });
  return { digest, content, ...removal };
}

const tenantRows = (t: MemoryTables, tenantId: string): RejectedValueRow[] =>
  [...t.rejected.values()].filter((r) => r.tenantId === tenantId).sort(newestFirst);

export function memoryRejections(t: MemoryTables): Rejections {
  return {
    apply: async (rejection) => applyIn(t, rejection),
    async lift(tenantId, digestPrefix, actor) {
      const matches = tenantRows(t, tenantId).filter((r) => r.digest.startsWith(digestPrefix));
      const target = matches[0];
      if (target === undefined) return { status: 'not_found' };
      if (matches.length > 1) return { status: 'ambiguous', candidates: structuredClone(matches) };
      t.rejected.delete(tenantKey(tenantId, target.digest));
      const metadata = { digest: target.digest, reason: target.reason };
      const targetId = target.sourceMemoryId ?? undefined;
      appendAudit(t, [{ tenantId, actor, op: 'unreject_value', targetId, metadata }]);
      return { status: 'ok', digest: target.digest, reason: target.reason };
    },
    list: async (tenantId) => structuredClone(tenantRows(t, tenantId)),
    async refusedAmong(checks) {
      return checks.map(({ tenantId, entryId, content }) => {
        const digest = rejectionDigest(content);
        if (!t.rejected.has(tenantKey(tenantId, digest))) return false;
        const stored = t.entries.get(entryId);
        return stored === undefined || stored.tenantId !== tenantId || rejectionDigest(stored.content) !== digest;
      });
    },
  };
}
