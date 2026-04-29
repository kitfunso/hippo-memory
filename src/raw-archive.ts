import type { DatabaseSyncLike } from './db.js';
import { isFtsAvailable } from './db.js';

export interface ArchiveOpts {
  reason: string;
  who: string;
}

/**
 * The only legitimate path to remove a `kind='raw'` row from `memories`.
 *
 * Snapshots the full row into `raw_archive`, flips `kind` to `'archived'` so the
 * append-only trigger lets the delete through, then deletes the row. All in one
 * transaction.
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

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO raw_archive (memory_id, archived_at, reason, archived_by, payload_json) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, new Date().toISOString(), opts.reason, opts.who, JSON.stringify(row));
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
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
