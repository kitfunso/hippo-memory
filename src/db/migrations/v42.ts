import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v42: Migration = {
    version: 42,
    up: (db) => {
      // W1 handoff envelope (trajectories/01M2BQTM4AGFVMYY7G2XV5G7WY/plan.md).
      // Five nullable columns so the envelope carries evidence and outcome
      // and W2/W5 can filter on them without parsing JSON.
      if (!tableHasColumn(db, 'session_handoffs', 'constraints_json')) {
        db.exec(`ALTER TABLE session_handoffs ADD COLUMN constraints_json TEXT`);
      }
      if (!tableHasColumn(db, 'session_handoffs', 'evidence_json')) {
        db.exec(`ALTER TABLE session_handoffs ADD COLUMN evidence_json TEXT`);
      }
      if (!tableHasColumn(db, 'session_handoffs', 'outcome')) {
        db.exec(`ALTER TABLE session_handoffs ADD COLUMN outcome TEXT`);
        // codex P2: backfill from session_complete so pre-existing handoffs don't
        // all read as unfinished and get injected by the new 72h ambient fallback.
        db.exec(`
          UPDATE session_handoffs SET outcome = (
            SELECT e.content FROM session_events e
            WHERE e.tenant_id = session_handoffs.tenant_id AND e.session_id = session_handoffs.session_id
              AND e.event_type = 'session_complete' AND e.content IN ('success','partial','failure')
            ORDER BY e.created_at DESC, e.id DESC LIMIT 1
          )
          WHERE outcome IS NULL AND EXISTS (
            SELECT 1 FROM session_events e
            WHERE e.tenant_id = session_handoffs.tenant_id AND e.session_id = session_handoffs.session_id
              AND e.event_type = 'session_complete' AND e.content IN ('success','partial','failure')
          )
        `);
      }
      if (!tableHasColumn(db, 'session_handoffs', 'target_runtime')) {
        db.exec(`ALTER TABLE session_handoffs ADD COLUMN target_runtime TEXT`);
      }
      if (!tableHasColumn(db, 'session_handoffs', 'card_id')) {
        db.exec(`ALTER TABLE session_handoffs ADD COLUMN card_id TEXT`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_session_handoffs_tenant_outcome ON session_handoffs(tenant_id, outcome, created_at DESC)`);
    },
};
