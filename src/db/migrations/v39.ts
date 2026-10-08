import * as os from 'os';
import * as path from 'path';
import { deriveOriginProject, originFromSource, isGlobalStoreRoot } from '../../project-identity.js';
import { raiseMinBinary } from '../meta.js';
import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v39: Migration = {
    version: 39,
    up: (db, ctx) => {
      // Memory scope isolation.
      // origin_project: '<name>' = owned by that project, '' = user-global,
      // NULL = legacy/unknown (ambient context treats NULL as deny).
      if (!tableHasColumn(db, 'memories', 'origin_project')) {
        db.exec(`ALTER TABLE memories ADD COLUMN origin_project TEXT`);
      }
      // Backfill on store-location evidence only (no path-tag guessing):
      // 1. Rows shared from a project carry source 'shared:<project>:<ts>' -
      //    take <project>; a share whose <project> is the home dir basename
      //    maps to '' (user-global).
      // 2. Every other row was written into THIS store, so it takes the
      //    store's own origin: `<project>/.hippo` -> '<project>', the
      //    home/global store -> '' (user-global).
      // Rows stay NULL only when no hippoRoot was provided.
      const hippoRoot = ctx?.hippoRoot;
      if (hippoRoot) {
        // Provenance-source evidence first (shared:<project>: / promoted:<localRoot>,
        // parsed by the same helper the markdown-import stamp uses), then the
        // store's own location for everything else.
        const homeName = path.basename(os.homedir()).toLowerCase();
        // SAFETY: sourcedRows' shape matches the two columns (id, source)
        // named in the SELECT above.
        const sourcedRows = db.prepare(
          `SELECT id, source FROM memories WHERE origin_project IS NULL AND (source LIKE 'shared:%' OR source LIKE 'promoted:%')`,
        ).all() as Array<{ id: string; source: string }>;
        const setOrigin = db.prepare(`UPDATE memories SET origin_project = ? WHERE id = ?`);
        for (const row of sourcedRows) {
          const origin = originFromSource(row.source, homeName);
          if (origin === null) continue;
          setOrigin.run(origin, row.id);
        }
        // The global root itself is ALWAYS user-global (''), regardless of
        // what surrounds it on disk - a HIPPO_HOME inside a dotfiles git
        // repo must not stamp the whole corpus with that repo's name.
        const storeOrigin = isGlobalStoreRoot(hippoRoot)
          ? ''
          : deriveOriginProject(path.dirname(hippoRoot));
        db.prepare(`UPDATE memories SET origin_project = ? WHERE origin_project IS NULL`).run(storeOrigin);
      }
      // Rollback-safety guard (v24 precedent): a pre-isolation binary opening
      // this DB would ignore origin_project and the secret veto and resume
      // injecting cross-project rows. 1.24.0 is the first version with the
      // isolation behavior. Forward-only - never lower an existing minimum.
      raiseMinBinary(db, '1.24.0');
    },
};
