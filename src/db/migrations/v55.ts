import { tableHasColumn, tableExists } from '../tables.js';
import type { Migration } from './types.js';

export const v55: Migration = {
    version: 55,
    up: (db) => {
      // No backfill and no floor raise: an older binary names its INSERT columns, so it still writes.
      if (!tableExists(db, 'delivery_events')) return;
      if (!tableHasColumn(db, 'delivery_events', 'tool_use_id')) {
        db.exec('ALTER TABLE delivery_events ADD COLUMN tool_use_id TEXT');
      }
      if (!tableHasColumn(db, 'delivery_events', 'failure_id')) {
        db.exec('ALTER TABLE delivery_events ADD COLUMN failure_id INTEGER');
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_events_tool_call
        ON delivery_events(tenant_id, session_id, tool_use_id)
        WHERE tool_use_id IS NOT NULL AND turn_seq IS NOT NULL`);
    },
};
