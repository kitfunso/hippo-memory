import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseSyncLike } from './db.js';

const LAYERS = ['episodic', 'buffer', 'semantic'] as const;
const MAX_WARN_LOGS = 5;

/**
 * Path A backfill cleanup: existing raw_archive rows that were archived BEFORE
 * commit 70180b5 left their markdown mirrors at <hippoRoot>/<layer>/<id>.md
 * with original content intact. The DB is already redacted via migration v20;
 * this function deletes those filesystem mirrors so RTBF holds for historical
 * archives too.
 *
 * Per-row tracking via raw_archive.mirror_cleaned_at (added in v21):
 *   - SELECT only rows WHERE mirror_cleaned_at IS NULL.
 *   - On success (every layer either deleted or didn't exist), UPDATE the row
 *     with the cleanup timestamp.
 *   - On any unlink failure, leave mirror_cleaned_at NULL so the next
 *     openHippoDb call retries. Warn (capped at MAX_WARN_LOGS rows per call).
 *
 * Steady-state cost is one SELECT returning empty after every row has been
 * cleaned successfully.
 */
export function cleanupArchivedMirrors(hippoRoot: string, db: DatabaseSyncLike): void {
  const rows = db
    .prepare(`SELECT memory_id FROM raw_archive WHERE mirror_cleaned_at IS NULL`)
    .all() as Array<{ memory_id: string }>;

  if (rows.length === 0) return;

  const update = db.prepare(`UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`);
  const now = new Date().toISOString();
  let warnCount = 0;

  for (const row of rows) {
    let allOk = true;
    for (const layer of LAYERS) {
      const filePath = path.join(hippoRoot, layer, `${row.memory_id}.md`);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        allOk = false;
        if (warnCount < MAX_WARN_LOGS) {
          console.warn(
            `cleanupArchivedMirrors: unlink failed for ${filePath} (will retry on next DB open):`,
            err,
          );
          warnCount += 1;
        }
      }
    }
    if (allOk) {
      update.run(now, row.memory_id);
    }
  }
}
