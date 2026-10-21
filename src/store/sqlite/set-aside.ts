// Takes an imported agent note out of recall on the caller's transaction; the note sync and the project repair both use
// it.
import { appendAuditEvent } from './audit.js';
import { SYNC_ACTOR } from '../../base/memory/agent-memory-tools.js';
import type { DatabaseSyncLike } from '../../db/index.js';
import { insertDormantRow } from './dormant-rows.js';
import { calculateStrength, type LossAversion, type MemoryEntry } from '../../base/memory/memory.js';
import { deleteEntryRowInTx, setEntryTagsInTx } from './entry-writes.js';
import type { SetAsideResult, SetAsideWhy } from '../port/project-tags.js';

/** Design 6's set-aside on the caller's transaction: a pinned row only loses the tag, any other goes dormant,
 * restorable. */
export function setAsideRow(
  db: DatabaseSyncLike,
  tag: string,
  row: MemoryEntry,
  why: SetAsideWhy,
  rules: LossAversion,
): SetAsideResult {
  const untagged: MemoryEntry = { ...row, tags: row.tags.filter((t) => t !== tag) };
  const audit = (metadata: Record<string, string | boolean>): void =>
    appendAuditEvent(db, {
      tenantId: row.tenantId,
      actor: SYNC_ACTOR,
      op: 'agent_memory_set_aside',
      targetId: row.id,
      metadata,
    });
  if (row.pinned) {
    setEntryTagsInTx(db, untagged);
    audit({ why, untagged: true });
    return { kind: 'untagged', entry: untagged };
  }
  const now = new Date();
  // Sleep's dormant move skips kept rows, so the steps are written out here without its filter.
  insertDormantRow(db, {
    entry: untagged,
    strength: calculateStrength(row, now, rules),
    reason: 'source-deleted',
    dormantAt: now.toISOString(),
  });
  deleteEntryRowInTx(db, row, SYNC_ACTOR);
  audit({ why });
  return { kind: 'dormant', id: row.id };
}
