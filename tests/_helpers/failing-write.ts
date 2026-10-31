// Writes `entry` through the promote path with a trigger that aborts the promote audit row, so a failure after the INSERT
// reaches the production entry's SAVEPOINT the way a real audit failure would.
import { writePromotedEntry } from '../../src/store/entry-writes.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import type { MemoryEntry } from '../../src/core/memory.js';

export function writeEntryThenFail(hippoRoot: string, entry: MemoryEntry): void {
  const db = openHippoDb(hippoRoot);
  try {
    db.exec(
      `CREATE TRIGGER test_force_promote_failure BEFORE INSERT ON audit_log WHEN NEW.op = 'promote' ` +
      `BEGIN SELECT RAISE(ABORT, 'forced'); END`,
    );
    try {
      writePromotedEntry(hippoRoot, entry, {
        sourceId: 'test',
        auditAs: { tenantId: entry.tenant_id ?? 'default', actor: 'test' },
      });
    } finally {
      db.exec('DROP TRIGGER test_force_promote_failure');
    }
  } finally {
    closeHippoDb(db);
  }
}
