// GET /ready's probe of hippo.db: one cheap read on the store's handle.
import { existsSync } from 'node:fs';
import type { Readiness } from '../../../base/records/diagnostics.js';
import { getHippoDbPath } from '../../../db/index.js';
import { answered } from '../runtime/bound.js';
import type { Handles } from '../runtime/open.js';

export function sqliteReadiness({ on, files }: Handles): Readiness {
  return {
    ping: () =>
      answered(() => {
        // A probe must not create the store; the first write does, so a root with none yet
        // is ready.
        if (!existsSync(getHippoDbPath(files.hippoRoot))) return;
        on((db) => {
          db.prepare('SELECT 1').get();
        });
      }),
  };
}
