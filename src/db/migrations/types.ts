import type { DatabaseSyncLike } from '../sqlite.js';

/** Context for migrations that need to know where the store lives. hippoRoot is the store directory (e.g. `<project>/.hippo`);
 * undefined only for callers that open a DB without a filesystem store. */
export type MigrationContext = { hippoRoot?: string };

export type Migration = {
  version: number;
  up: (db: DatabaseSyncLike, ctx?: MigrationContext) => void;
};
