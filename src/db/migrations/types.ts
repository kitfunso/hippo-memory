import type { DatabaseSyncLike } from '../sqlite.js';

/**
 * Context passed to migrations that need to know WHERE the store lives.
 * hippoRoot is the store directory (e.g. `<project>/.hippo`); undefined only
 * for callers that open a DB without a filesystem store notion (none today).
 */
export type MigrationContext = { hippoRoot?: string };

export type Migration = {
  version: number;
  up: (db: DatabaseSyncLike, ctx?: MigrationContext) => void;
};
