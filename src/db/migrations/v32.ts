import { tableExists } from '../tables.js';
import type { Migration } from './types.js';

const PROCESSES_TABLE = `
          CREATE TABLE processes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            process_name TEXT NOT NULL,
            description TEXT,
            steps TEXT NOT NULL DEFAULT '[]',
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            change_summary TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES processes(id) ON DELETE SET NULL
          )
        `;

const IDX_PROCESSES_TENANT_STATUS = `
          CREATE INDEX IF NOT EXISTS idx_processes_tenant_status
          ON processes(tenant_id, status)
        `;

const IDX_PROCESSES_MEMORY = `
          CREATE INDEX IF NOT EXISTS idx_processes_memory
          ON processes(memory_id) WHERE memory_id IS NOT NULL
        `;

// Cross-tenant safety vs the referenced memory (verbatim mirror of the
// v31 incidents / v30 decisions tenant-match triggers).
const TRG_PROCESSES_TENANT_MATCH_INSERT = `
          CREATE TRIGGER IF NOT EXISTS trg_processes_tenant_match_insert
          BEFORE INSERT ON processes
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'processes.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `;

const TRG_PROCESSES_TENANT_MATCH_UPDATE = `
          CREATE TRIGGER IF NOT EXISTS trg_processes_tenant_match_update
          BEFORE UPDATE ON processes
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'processes.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `;

// Cross-tenant safety vs the successor process (self-FK; mirrors the v30 supersede trigger): superseded_by is set only via the supersede UPDATE
// and the successor, already present in the same transaction, must share the tenant.
const TRG_PROCESSES_SUPERSEDE_TENANT_MATCH_UPDATE = `
          CREATE TRIGGER IF NOT EXISTS trg_processes_supersede_tenant_match_update
          BEFORE UPDATE ON processes
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM processes WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'processes.superseded_by must reference a process in the same tenant')
            END;
          END
        `;

export const v32: Migration = {
    version: 32,
    up: (db) => {
      // Process first-class object (living process map): it evolves via the v30 supersede path, each version recording change_summary and full steps (JSON).
      // Combines the v31 tenant-match trigger pair with the v30 superseded_by self-FK; version is server-derived (predecessor + 1); only an active head closes.
      if (!tableExists(db, 'processes')) {
        db.exec(PROCESSES_TABLE);
        db.exec(IDX_PROCESSES_TENANT_STATUS);
        db.exec(IDX_PROCESSES_MEMORY);
        db.exec(TRG_PROCESSES_TENANT_MATCH_INSERT);
        db.exec(TRG_PROCESSES_TENANT_MATCH_UPDATE);
        db.exec(TRG_PROCESSES_SUPERSEDE_TENANT_MATCH_UPDATE);
      }
    },
};
