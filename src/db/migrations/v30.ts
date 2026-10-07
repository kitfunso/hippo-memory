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

// Cross-tenant safety vs the successor decision (self-FK). superseded_by
// is set only via UPDATE (the supersede path); the successor must share
// the tenant. The successor row already exists in the same transaction
// when this fires, so the subquery resolves.
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
      // Decision first-class object.
      // Promotes `hippo decide` from a tagged memory (which decayed on a 90-day
      // half-life even while the decision was still in force) to a dedicated
      // decisions table that is the source of truth. The memory mirror is kept
      // for recall but is no longer authoritative; memory_id is NULLABLE with
      // ON DELETE SET NULL so forget/consolidate/archive does not lose a
      // decision. Mirrors the v29 predictions tenant-match trigger pattern.
      //
      // status (active|superseded|closed): superseded carries a self-FK
      // superseded_by to the successor decision; closed is a terminal
      // retire-without-successor. A superseded_by same-tenant trigger makes
      // cross-tenant supersession unrepresentable at the schema level.
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
