import { tableExists } from '../tables.js';
import type { Migration } from './types.js';

const CREATE_TABLE_INCIDENTS_SQL = `
          CREATE TABLE incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            incident_text TEXT NOT NULL,
            context TEXT,
            status TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'resolved', 'closed')),
            resolution_text TEXT,
            resolved_at TEXT,
            closed_at TEXT,
            linked_memory_ids TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL
          )
        `;

const CREATE_INDEX_IDX_INCIDENTS_TENANT_STATUS_SQL = `
          CREATE INDEX IF NOT EXISTS idx_incidents_tenant_status
          ON incidents(tenant_id, status)
        `;

const CREATE_INDEX_IDX_INCIDENTS_MEMORY_SQL = `
          CREATE INDEX IF NOT EXISTS idx_incidents_memory
          ON incidents(memory_id) WHERE memory_id IS NOT NULL
        `;

const CREATE_TRIGGER_TRG_INCIDENTS_TENANT_MATCH_INSERT_SQL = `
          CREATE TRIGGER IF NOT EXISTS trg_incidents_tenant_match_insert
          BEFORE INSERT ON incidents
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'incidents.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `;

const CREATE_TRIGGER_TRG_INCIDENTS_TENANT_MATCH_UPDATE_SQL = `
          CREATE TRIGGER IF NOT EXISTS trg_incidents_tenant_match_update
          BEFORE UPDATE ON incidents
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'incidents.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `;

export const v31: Migration = {
    version: 31,
    up: (db) => {
      // Incident first-class object: a postmortem capsule with an open -> resolved -> closed lifecycle (no supersede) and linked receipts (JSON ids).
      // Memory mirror is for recall only (memory_id NULLABLE ON DELETE SET NULL); BEFORE INSERT/UPDATE triggers mirror the v30 tenant-match triggers.
      if (!tableExists(db, 'incidents')) {
        db.exec(CREATE_TABLE_INCIDENTS_SQL);
        db.exec(CREATE_INDEX_IDX_INCIDENTS_TENANT_STATUS_SQL);
        db.exec(CREATE_INDEX_IDX_INCIDENTS_MEMORY_SQL);
        // Cross-tenant safety vs the referenced memory (verbatim mirror of the
        // v30 decisions tenant-match triggers; no supersede trigger).
        db.exec(CREATE_TRIGGER_TRG_INCIDENTS_TENANT_MATCH_INSERT_SQL);
        db.exec(CREATE_TRIGGER_TRG_INCIDENTS_TENANT_MATCH_UPDATE_SQL);
      }
    },
};
