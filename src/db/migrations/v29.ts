import { tableExists } from '../tables.js';
import type { Migration } from './types.js';

export const v29: Migration = {
    version: 29,
    up: (db) => {
      // E2 prediction first-class object (docs/plans/2026-05-26-e2-prediction-object.md).
      // Adds a canonical predictions table for J3 reference-class /
      // planning-fallacy detector (a follow-up episode). Predictions
      // duplicate claim_text in the table itself so memory deletion
      // (forget/consolidate/archive) does not lose prediction data; FK
      // memory_id is NULLABLE with ON DELETE SET NULL.
      //
      // Cross-tenant safety: BEFORE INSERT + BEFORE UPDATE triggers
      // enforce tenant_id match against the referenced memory. SQLite's
      // ON DELETE SET NULL is incompatible with composite FK where one
      // side is NOT NULL, so the trigger pattern replaces a composite
      // FK target. Precedent: v14 memories.kind trigger pair at db.ts:298-322.
      //
      // CHECK constraint pins closure_state to (open|closed|closed-unknown).
      // J3 computes accuracy (clean vs regressed) from (estimate_value,
      // actual_value) at query time.
      if (!tableExists(db, 'predictions')) {
        db.exec(`
          CREATE TABLE predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            class_tag TEXT NOT NULL,
            claim_text TEXT NOT NULL,
            estimate_value REAL,
            estimate_unit TEXT,
            target_date TEXT,
            actual_value REAL,
            closure_state TEXT NOT NULL DEFAULT 'open'
              CHECK (closure_state IN ('open', 'closed', 'closed-unknown')),
            closed_at TEXT,
            closure_note TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL
          )
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_predictions_tenant_class
          ON predictions(tenant_id, class_tag, closure_state)
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_predictions_memory
          ON predictions(memory_id) WHERE memory_id IS NOT NULL
        `);
        // Cross-tenant safety: tenant_id must match the referenced memory's
        // tenant_id when memory_id IS NOT NULL. INSERT + UPDATE pair, mirroring
        // v14 memories.kind enforcement (db.ts:298-322).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_predictions_tenant_match_insert
          BEFORE INSERT ON predictions
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'predictions.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_predictions_tenant_match_update
          BEFORE UPDATE ON predictions
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'predictions.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
      }
    },
};
