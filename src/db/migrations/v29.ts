import { tableExists } from '../tables.js';
import type { Migration } from './types.js';

const CREATE_TABLE_PREDICTIONS_SQL = `
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
        `;

const CREATE_INDEX_IDX_PREDICTIONS_TENANT_CLASS_SQL = `
          CREATE INDEX IF NOT EXISTS idx_predictions_tenant_class
          ON predictions(tenant_id, class_tag, closure_state)
        `;

const CREATE_INDEX_IDX_PREDICTIONS_MEMORY_SQL = `
          CREATE INDEX IF NOT EXISTS idx_predictions_memory
          ON predictions(memory_id) WHERE memory_id IS NOT NULL
        `;

const CREATE_TRIGGER_TRG_PREDICTIONS_TENANT_MATCH_INSERT_SQL = `
          CREATE TRIGGER IF NOT EXISTS trg_predictions_tenant_match_insert
          BEFORE INSERT ON predictions
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'predictions.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `;

const CREATE_TRIGGER_TRG_PREDICTIONS_TENANT_MATCH_UPDATE_SQL = `
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
        `;

export const v29: Migration = {
    version: 29,
    up: (db) => {
      // Prediction first-class object: claim_text is duplicated so deleting the memory loses nothing; memory_id is NULLABLE ON DELETE SET NULL.
      // Tenant-match triggers replace a composite FK, which is incompatible with ON DELETE SET NULL; closure_state is CHECKed to open|closed|closed-unknown.
      if (!tableExists(db, 'predictions')) {
        db.exec(CREATE_TABLE_PREDICTIONS_SQL);
        db.exec(CREATE_INDEX_IDX_PREDICTIONS_TENANT_CLASS_SQL);
        db.exec(CREATE_INDEX_IDX_PREDICTIONS_MEMORY_SQL);
        // Cross-tenant safety: tenant_id must match the referenced memory's tenant_id when memory_id IS NOT NULL;
        // INSERT + UPDATE pair, mirroring the v14 memories.kind enforcement.
        db.exec(CREATE_TRIGGER_TRG_PREDICTIONS_TENANT_MATCH_INSERT_SQL);
        db.exec(CREATE_TRIGGER_TRG_PREDICTIONS_TENANT_MATCH_UPDATE_SQL);
      }
    },
};
