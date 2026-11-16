// Sleep's links from an old memory to the newer one that replaces it, on hippo.db: a hide links the
// old row, a soft link marks it stale under replaced-by:<newId>.
import type { MemoryEntry } from '../../../base/memory/entry.js';
import { isSuperseded } from '../../../base/memory/liveness.js';
import { markStale, REPLACED_BY_PREFIX } from '../../../base/memory/stale-mark.js';
import type { SupersedeLink } from '../../../base/ports/store/consolidation.js';
import { type DatabaseSyncLike, withWriteScope } from '../../../db/index.js';
import { notSupersededIn } from '../../../db/sql-predicates.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { appendAuditEvents } from '../audit/audit.js';
import { readEntriesByIds } from '../entries/entry-reads.js';
import { syncFtsRow } from '../entries/entry-row.js';
import { supersedeInTx, writeEntryMirrors } from '../entries/entry-writes.js';
import type { StoreFiles } from '../runtime/open.js';

const ACTOR = 'sleep';
const AUDIT_RULE = { by: 'sleep', rule: 'one-span' } as const;

// Keeps the half-life, so decay does not retire the row sooner than it would have.
const keepHalfLife = (days: number): number => days;

/** The row stale under replaced-by:<newId> and its audit row, in the caller's transaction; null
 * when the row is gone, superseded or already stale. */
function markReplacedInTx(db: DatabaseSyncLike, link: SupersedeLink): MemoryEntry | null {
  const { tenantId, id, newId } = link;
  const entry = readEntriesByIds(db, [id], tenantId).get(id);
  if (!entry || isSuperseded(entry) || entry.confidence === 'stale') return null;
  const marked = markStale(entry, `${REPLACED_BY_PREFIX}${newId}`, keepHalfLife);
  const won = cachedStatement(
    db,
    `UPDATE memories SET confidence = 'stale', tags_json = ?, updated_at = datetime('now') ` +
      `WHERE id = ? AND tenant_id = ? AND confidence = ? AND ${notSupersededIn()}`,
  ).run(JSON.stringify(marked.tags), id, tenantId, entry.confidence);
  if (Number(won.changes ?? 0) === 0) return null;
  syncFtsRow(db, marked);
  appendAuditEvents(db, [
    {
      tenantId,
      actor: ACTOR,
      op: 'supersede',
      targetId: id,
      metadata: { newId, ...AUDIT_RULE, mode: 'soft' },
    },
  ]);
  return marked;
}

/** Applies the links in order in one transaction, so a chain lands oldest first; mirrors of the
 * rows marked stale follow the commit. Returns the ids changed. */
export function applySupersedeLinks(
  db: DatabaseSyncLike,
  files: StoreFiles,
  links: readonly SupersedeLink[],
): string[] {
  const marked: MemoryEntry[] = [];
  const changed = withWriteScope(db, 'sleep_supersede_links', () => {
    const ids: string[] = [];
    for (const link of links) {
      const { tenantId, id, newId } = link;
      if (link.mode === 'hide') {
        const metadata = { ...AUDIT_RULE, mode: 'hide' };
        if (supersedeInTx(db, { tenantId, id, newId, actor: ACTOR, metadata })) ids.push(id);
        continue;
      }
      const entry = markReplacedInTx(db, link);
      if (!entry) continue;
      marked.push(entry);
      ids.push(id);
    }
    return ids;
  });
  for (const entry of marked) writeEntryMirrors(files.hippoRoot, entry);
  return changed;
}
