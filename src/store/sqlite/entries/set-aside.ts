// Takes an imported agent note out of recall on the caller's transaction; the note sync and the
// project repair both use it.
import { appendAuditEvents } from '../audit/audit.js';
import type { StoreModel } from '../runtime/open.js';
import { SYNC_ACTOR } from '../../../base/memory/agent-memory-tools.js';
import type { DatabaseSyncLike } from '../../../db/index.js';
import { insertDormantRow } from '../dormant/dormant-rows.js';
import { calculateStrengthAt } from '../../../base/memory/strength.js';
import type { MemoryEntry } from '../../../base/memory/entry.js';
import { deleteEntryRowInTx, setEntryTagsInTx } from './entry-writes.js';
import type { SetAsideResult, SetAsideWhy } from '../../../base/records/project-tags.js';
import { handleNow } from '../runtime/handle-clock.js';

export interface SetAsideRowOptions {
  readonly tag: string;
  readonly row: MemoryEntry;
  readonly why: SetAsideWhy;
  readonly rules: StoreModel;
}

/** Design 6's set-aside on the caller's transaction: a pinned row only loses the tag, any other
 * goes dormant, restorable. */
export function setAsideRow(
  db: DatabaseSyncLike,
  { tag, row, why, rules }: SetAsideRowOptions,
): SetAsideResult {
  const untagged: MemoryEntry = { ...row, tags: row.tags.filter((t) => t !== tag) };
  const audit = (metadata: Record<string, string | boolean>): void =>
    appendAuditEvents(db, [
      {
        tenantId: row.tenantId,
        actor: SYNC_ACTOR,
        op: 'agent_memory_set_aside',
        targetId: row.id,
        metadata,
      },
    ]);
  if (row.pinned) {
    setEntryTagsInTx(db, untagged);
    audit({ why, untagged: true });
    return { kind: 'untagged', entry: untagged };
  }
  const now = handleNow(db);
  // Sleep's dormant move skips kept rows, so the steps are written out here without its filter.
  insertDormantRow(db, {
    entry: untagged,
    strength: calculateStrengthAt(row, now, rules.strength),
    reason: 'source-deleted',
    dormantAt: now.toISOString(),
  });
  deleteEntryRowInTx(db, row, SYNC_ACTOR);
  audit({ why });
  return { kind: 'dormant', id: row.id };
}
