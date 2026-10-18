// hippo.db's DashboardReads group: scans on a fresh open and the commit signal on one held read-only connection.
import * as fs from 'fs';
import { closeHippoDb, getHippoDbPath, openHippoDbReadOnly, type DatabaseSyncLike } from '../../db/index.js';
import { pragmaDataVersion } from '../../db/meta.js';
import { openConflictsNamingAt } from './conflicts.js';
import { hasVectorAt, scanAt, scanTextAt } from '../dashboard-reads.js';
import type { Handles } from './open.js';
import type { DashboardReads } from '../port/dashboard-reads.js';
import { openStore } from './handles.js';

/** Scans run on a fresh writable open, which runs any pending migration and legacy embeddings.json import first; the
 * commit signal and point reads use one read-only connection, opened on the first call that finds a database. */
export function sqliteDashboardReads({ on, files }: Handles): DashboardReads {
  let held: DatabaseSyncLike | null = null;
  const reader = (): DatabaseSyncLike | null => {
    if (held === null && fs.existsSync(getHippoDbPath(files.hippoRoot))) held = openHippoDbReadOnly(files.hippoRoot);
    return held;
  };
  return {
    commitCount() {
      const db = reader();
      return db === null ? null : pragmaDataVersion(db);
    },
    scan: (tenantId, visit) => on((db) => scanAt(db, tenantId, visit), openStore),
    scanText(tenantId, visit) {
      on((db) => scanTextAt(db, tenantId, visit), openStore);
    },
    openConflictsOf: (tenantId, memoryId) => on((db) => openConflictsNamingAt(db, tenantId, memoryId), openStore),
    hasVector(id) {
      const db = reader();
      return db !== null && hasVectorAt(db, id);
    },
    close() {
      if (held !== null) closeHippoDb(held);
      held = null;
    },
  };
}
