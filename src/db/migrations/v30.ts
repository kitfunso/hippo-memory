import { tableExists } from '../tables.js';
import type { Migration } from './types.js';

const DECISIONS_TABLE = `
          CREATE TABLE decisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            decision_text TEXT NOT NULL,
            context TEXT,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES decisions(id) ON DELETE SET NULL
          )
        `;

const IDX_DECISIONS_TENANT_STATUS = `
          CREATE INDEX IF NOT EXISTS idx_decisions_tenant_status
          ON decisions(tenant_id, status)
        `;

const IDX_DECISIONS_MEMORY = `
          CREATE INDEX IF NOT EXISTS idx_decisions_memory
          ON decisions(memory_id) WHERE memory_id IS NOT NULL
        `;

// Cross-tenant safety vs the referenced memory (mirrors predictions v29).
const TRG_DECISIONS_TENANT_MATCH_INSERT = `
          CREATE TRIGGER IF NOT EXISTS trg_decisions_tenant_match_insert
          BEFORE INSERT ON decisions
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'decisions.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `;

const TRG_DECISIONS_TENANT_MATCH_UPDATE = `
          CREATE TRIGGER IF NOT EXISTS trg_decisions_tenant_match_update
          BEFORE UPDATE ON decisions
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'decisions.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `;

// Cross-tenant safety vs the successor decision (self-FK): superseded_by is set only via the supersede UPDATE and the successor,
// which already exists in the same transaction when this fires, must share the tenant.
const TRG_DECISIONS_SUPERSEDE_TENANT_MATCH_UPDATE = `
          CREATE TRIGGER IF NOT EXISTS trg_decisions_supersede_tenant_match_update
          BEFORE UPDATE ON decisions
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM decisions WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'decisions.superseded_by must reference a decision in the same tenant')
            END;
          END
        `;

export const v30: Migration = {
    version: 30,
    up: (db) => {
      // Decision first-class object, the source of truth for `hippo decide`; the memory mirror serves recall only, memory_id NULLABLE ON DELETE SET NULL.
      // status active|superseded|closed (closed = retired without successor); a same-tenant trigger on superseded_by blocks cross-tenant supersession.
      if (!tableExists(db, 'decisions')) {
        db.exec(DECISIONS_TABLE);
        db.exec(IDX_DECISIONS_TENANT_STATUS);
        db.exec(IDX_DECISIONS_MEMORY);
        db.exec(TRG_DECISIONS_TENANT_MATCH_INSERT);
        db.exec(TRG_DECISIONS_TENANT_MATCH_UPDATE);
        db.exec(TRG_DECISIONS_SUPERSEDE_TENANT_MATCH_UPDATE);
      }
    },
};
