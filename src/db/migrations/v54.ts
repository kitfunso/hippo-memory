import { SESSION_OWNERS_DDL } from '../continuity.js';
import { tableHasColumn, tableExists } from '../tables.js';
import type { Migration } from './types.js';

const OWNER_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['task_snapshots', 'owner_subject'],
  ['task_snapshots', 'origin_project'],
  ['session_handoffs', 'owner_subject'],
  ['session_handoffs', 'origin_project'],
  ['failure_log', 'owner_subject'],
  ['failure_log', 'origin_project'],
  ['compactions', 'request_id'],
  ['failure_log', 'request_id'],
];

export const v54: Migration = {
    version: 54,
    up: (db) => {
      // Rows from before this stay NULL: no backfill, so they never match an owner's key.
      // No floor raise here: the first session bind or owner snapshot raises it, so an unused store stays open to older binaries.
      for (const [t, c] of OWNER_COLUMNS) {
        if (tableExists(db, t) && !tableHasColumn(db, t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT`);
      }
      db.exec(SESSION_OWNERS_DDL);
    },
};
