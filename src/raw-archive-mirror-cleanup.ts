import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseSyncLike } from './db.js';
import { getMeta, setMeta } from './db.js';

const META_KEY = 'gdpr_v20_mirror_cleanup';
const LAYERS = ['episodic', 'buffer', 'semantic'] as const;

/**
 * Path A backfill cleanup: existing raw_archive rows that were archived BEFORE
 * commit 70180b5 left their markdown mirrors at <hippoRoot>/<layer>/<id>.md
 * with original content intact. The DB is already redacted via migration v20;
 * this function deletes those filesystem mirrors so RTBF holds for historical
 * archives too.
 *
 * Idempotent via the gdpr_v20_mirror_cleanup meta flag — runs once per DB,
 * even across multiple openHippoDb() calls.
 */
export function cleanupArchivedMirrors(hippoRoot: string, db: DatabaseSyncLike): void {
  if (getMeta(db, META_KEY, '') === 'done') return;

  const rows = db.prepare(`SELECT memory_id FROM raw_archive`).all() as Array<{ memory_id: string }>;
  for (const row of rows) {
    for (const layer of LAYERS) {
      const filePath = path.join(hippoRoot, layer, `${row.memory_id}.md`);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Best-effort: filesystem failure does not block the meta flag.
        // The next openHippoDb() will skip the loop entirely (flag set below).
        // If a real concern emerges, run `hippo gdpr scan-mirrors` (v0.40 tool).
      }
    }
  }

  setMeta(db, META_KEY, 'done');
}
