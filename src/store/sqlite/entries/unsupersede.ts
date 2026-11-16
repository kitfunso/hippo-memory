// The undo of a supersede, hidden by a link or only marked stale by sleep, inside the caller's write scope.
import type { MemoryEntry } from '../../../base/memory/entry.js';
import { KEPT_CURRENT_PREFIX, REPLACED_BY_PREFIX } from '../../../base/memory/stale-mark.js';
import {
  ConflictError,
  memoryNotFoundText,
  NotFoundError,
} from '../../../base/errors/api-errors.js';
import type { EntryRemoval } from '../../../base/ports/store/entry-writes.js';
import type { DatabaseSyncLike } from '../../../db/index.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { supersededIn } from '../../../db/sql-predicates.js';
import { appendAuditEvents } from '../audit/audit.js';
import { readEntriesByIds } from './entry-reads.js';
import { replaceFtsRows, updateMemoryRows } from './entry-row.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';

/** The successor id the row had, and the row as written. */
interface Undone {
  readonly was: string;
  readonly entry: MemoryEntry;
}

/** A hidden row loses its link by CAS; a soft-marked one (replaced-by: tag) turns observed. Either
 * way it gains a kept-current: tag, so sleep skips the pair, and one unsupersede row is written. */
export function undoSupersede(db: DatabaseSyncLike, { tenantId, actor, id }: EntryRemoval): Undone {
  const entry = readEntriesByIds(db, [id], tenantId).get(id);
  if (!entry) throw new NotFoundError(memoryNotFoundText(id));
  const hidden = cachedStatement(
    db,
    `SELECT superseded_by AS was FROM memories WHERE id = ? AND tenant_id = ? AND ${supersededIn()}`,
  ).get(id, tenantId) as { was: string } | undefined;
  const softTag = entry.tags.find((tag) => tag.startsWith(REPLACED_BY_PREFIX));
  const was = hidden?.was ?? softTag?.slice(REPLACED_BY_PREFIX.length);
  if (was === undefined) throw new ConflictError(`Memory ${id} is not superseded.`);
  if (hidden) {
    const cleared = cachedStatement(
      db,
      'UPDATE memories SET superseded_by = NULL WHERE id = ? AND tenant_id = ? AND superseded_by = ?',
    ).run(id, tenantId, hidden.was);
    if (Number(cleared.changes ?? 0) === 0) {
      throw new ConflictError(`Memory ${id} was changed by another writer`);
    }
  }
  const kept = `${KEPT_CURRENT_PREFIX}${was}`;
  const dropped = hidden ? [kept] : [softTag, kept];
  const next: MemoryEntry = {
    ...entry,
    supersededBy: null,
    confidence: hidden ? entry.confidence : 'observed',
    tags: [...entry.tags.filter((tag) => !dropped.includes(tag)), kept],
  };
  updateMemoryRows(db, [next]);
  replaceFtsRows(db, [next], [id]);
  if (entry.dagParentId) {
    markSummaryDirtyInTx(db, { summaryId: entry.dagParentId, tenantId, actor });
  }
  const mode = hidden ? 'hide' : 'soft';
  appendAuditEvents(db, [
    { tenantId, actor, op: 'unsupersede', targetId: id, metadata: { was, mode } },
  ]);
  return { was, entry: next };
}
