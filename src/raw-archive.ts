import type { DatabaseSyncLike } from './db.js';

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
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
