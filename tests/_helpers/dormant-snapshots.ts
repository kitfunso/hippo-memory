// Every dormant snapshot of a tenant, for tests that check what a whole store holds; production reads by id or origin.
import type { DatabaseSyncLike } from '../../src/db/sqlite.js';
import { dormantSnapshotsByIds } from '../../src/store/sqlite/dormant-rows.js';
import type { DormantSnapshot } from '../../src/store/port/agent-import.js';

/** The tenant's dormant memories whose snapshot still reads back, in table order. */
export function listDormantSnapshots(db: DatabaseSyncLike, tenantId: string): DormantSnapshot[] {
  // SAFETY: the SELECT names the one column read.
  const ids = (db.prepare('SELECT id FROM dormant_memories WHERE tenant_id = ?').all(tenantId) as { id: string }[]).map(
    (row) => row.id,
  );
  const byId = dormantSnapshotsByIds(db, tenantId, ids);
  return ids.flatMap((id) => byId.get(id) ?? []);
}
