import type { DatabaseSyncLike } from './db.js';
import { isFtsAvailable } from './db.js';
import { appendAuditEvent } from './audit.js';

export interface ArchiveOpts {
  reason: string;
  who: string;
}

// JSON.stringify cannot serialize BigInt by default. node:sqlite returns INTEGER
// columns as bigint when the value exceeds Number.MAX_SAFE_INTEGER. Coerce to
// string so the audit payload is always serializable.
function bigintSafeReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * The only legitimate path to remove a `kind='raw'` row from `memories`.
 *
 * Snapshots the full row into `raw_archive`, flips `kind` to `'archived'` so the
 * append-only trigger lets the delete through, then deletes the row. All in one
 * SAVEPOINT so it can be nested inside an outer transaction (e.g. batchWriteAndDelete).
 *
 * Throws if the row does not exist or is not `kind='raw'`.
 */
export function archiveRawMemory(db: DatabaseSyncLike, id: string, opts: ArchiveOpts): void {
  const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`memory not found: ${id}`);
  if (row.kind !== 'raw') {
    throw new Error(`memory ${id} is not raw (kind=${String(row.kind)})`);
  }

  // SAVEPOINT (not BEGIN) so this works whether or not we're already inside a
  // transaction. SQLite refuses BEGIN within a transaction; SAVEPOINT nests safely.
  db.exec('SAVEPOINT archive_raw');
  try {
    db.prepare(
      `INSERT INTO raw_archive (memory_id, archived_at, reason, archived_by, payload_json) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, new Date().toISOString(), opts.reason, opts.who, JSON.stringify(row, bigintSafeReplacer));
    // Flip kind to 'archived' so the BEFORE DELETE trigger no longer fires, then delete.
    db.prepare(`UPDATE memories SET kind = 'archived' WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    // FTS5 is a virtual table — no FK CASCADE applies. Purge the FTS row so the
    // archived content is not searchable after archive. Without this the original
    // raw text remains in memories_fts until the next DB-open backfill, defeating
    // GDPR right-to-be-forgotten.
    if (isFtsAvailable(db)) {
      try {
        db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(id);
      } catch {
        // Best effort only. The DELETE on memories already succeeded; FTS will
        // self-heal on next DB open via backfillFtsIndex.
      }
    }
    // A5 audit: emit archive_raw event inside the SAVEPOINT so the audit row is
    // committed atomically with the row deletion. Inline env-based tenant
    // resolution avoids importing src/tenant.ts (which would pull auth.ts and
    // create a small import cycle for a leaf module).
    try {
      appendAuditEvent(db, {
        tenantId: process.env.HIPPO_TENANT ?? 'default',
        actor: opts.who || 'cli',
        op: 'archive_raw',
        targetId: id,
        metadata: { reason: opts.reason },
      });
    } catch {
      // Audit must not crash the archive. Failures here mean the audit table
      // is unwritable; the archive itself has already succeeded.
    }
    db.exec('RELEASE SAVEPOINT archive_raw');
  } catch (e) {
    db.exec('ROLLBACK TO SAVEPOINT archive_raw');
    db.exec('RELEASE SAVEPOINT archive_raw');
    throw e;
  }
}
