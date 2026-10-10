import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseSyncLike } from './index.js';
import { errorMessage, log } from '../util/log.js';

const LAYERS = ['episodic', 'buffer', 'semantic'] as const;
const MAX_WARN_LOGS = 5;

/** Path A backfill cleanup: delete markdown mirrors (<hippoRoot>/<layer>/<id>.md) of rows archived before redaction, so RTBF holds for historical archives.
 * Tracked by raw_archive.mirror_cleaned_at: set only on success, so a failed unlink retries next connection. Returns whether all pending rows were cleaned. */
export function cleanupArchivedMirrors(hippoRoot: string, db: DatabaseSyncLike): boolean {
  // SAFETY: the SELECT above names exactly one column, memory_id (raw_archive.memory_id
  // is NOT NULL TEXT), so the row shape matches this assertion.
  const rows = db
    .prepare(`SELECT memory_id FROM raw_archive WHERE mirror_cleaned_at IS NULL`)
    .all() as Array<{ memory_id: string }>;

  if (rows.length === 0) return true;

  const update = db.prepare(`UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`);
  const now = new Date().toISOString();
  let warnCount = 0;
  let everyRowCleaned = true;

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
          log.warn(
            `cleanupArchivedMirrors: unlink failed for ${filePath} (will retry on next DB open): ${errorMessage(err)}`,
          );
          warnCount += 1;
        }
      }
    }
    if (allOk) {
      update.run(now, row.memory_id);
    } else {
      everyRowCleaned = false;
    }
  }
  return everyRowCleaned;
}
