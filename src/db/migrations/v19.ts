import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v19: Migration = {
    version: 19,
    up: (db) => {
      // v0.39 commit 3 (Slack hardening): widen slack_dlq with bucketing,
      // retry tracking, and the signature/timestamp pair that lets `hippo
      // slack dlq replay` re-verify before re-running ingest. ALTER ADD
      // COLUMN with DEFAULT is non-destructive — legacy rows take the
      // default values. Idempotent via tableHasColumn().
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
