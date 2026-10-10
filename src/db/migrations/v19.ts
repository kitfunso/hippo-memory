import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v19: Migration = {
    version: 19,
    up: (db) => {
      // Widen slack_dlq with bucketing, retry tracking and the signature/timestamp pair `hippo slack dlq replay` re-verifies;
      // ALTER ADD COLUMN with DEFAULT is non-destructive, so legacy rows take the defaults. Idempotent via tableHasColumn().
      if (!tableHasColumn(db, 'slack_dlq', 'team_id')) {
        db.exec(`ALTER TABLE slack_dlq ADD COLUMN team_id TEXT`);
      }
      if (!tableHasColumn(db, 'slack_dlq', 'bucket')) {
        db.exec(`ALTER TABLE slack_dlq ADD COLUMN bucket TEXT NOT NULL DEFAULT 'parse_error'`);
        // SQLite ALTER TABLE cannot add CHECK; bucket value enforcement is app-level.
      }
      if (!tableHasColumn(db, 'slack_dlq', 'retry_count')) {
        db.exec(`ALTER TABLE slack_dlq ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
      }
      if (!tableHasColumn(db, 'slack_dlq', 'signature')) {
        db.exec(`ALTER TABLE slack_dlq ADD COLUMN signature TEXT`);
      }
      if (!tableHasColumn(db, 'slack_dlq', 'slack_timestamp')) {
        db.exec(`ALTER TABLE slack_dlq ADD COLUMN slack_timestamp TEXT`);
      }
    },
};
