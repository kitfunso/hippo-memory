import { tableExists } from '../tables.js';
import type { Migration } from './types.js';

const CUSTOMER_NOTES_TABLE = `
          CREATE TABLE customer_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            customer TEXT NOT NULL,
            note TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            change_summary TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES customer_notes(id) ON DELETE SET NULL
          )
        `;

const IDX_CUSTOMER_NOTES_TENANT_STATUS = `
          CREATE INDEX IF NOT EXISTS idx_customer_notes_tenant_status
          ON customer_notes(tenant_id, status)
        `;

const IDX_CUSTOMER_NOTES_MEMORY = `
          CREATE INDEX IF NOT EXISTS idx_customer_notes_memory
          ON customer_notes(memory_id) WHERE memory_id IS NOT NULL
        `;

const IDX_CUSTOMER_NOTES_CUSTOMER = `
          CREATE INDEX IF NOT EXISTS idx_customer_notes_customer
          ON customer_notes(tenant_id, customer, status)
        `;

// Cross-tenant safety vs the referenced memory (verbatim mirror of the
// v35 project_briefs tenant-match triggers).
const TRG_CUSTOMER_NOTES_TENANT_MATCH_INSERT = `
          CREATE TRIGGER IF NOT EXISTS trg_customer_notes_tenant_match_insert
          BEFORE INSERT ON customer_notes
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'customer_notes.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `;

const TRG_CUSTOMER_NOTES_TENANT_MATCH_UPDATE = `
          CREATE TRIGGER IF NOT EXISTS trg_customer_notes_tenant_match_update
          BEFORE UPDATE ON customer_notes
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'customer_notes.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `;

// Cross-tenant safety vs the successor note (self-FK; verbatim mirror of the
// v35 project_briefs supersede trigger).
const TRG_CUSTOMER_NOTES_SUPERSEDE_TENANT_MATCH_UPDATE = `
          CREATE TRIGGER IF NOT EXISTS trg_customer_notes_supersede_tenant_match_update
          BEFORE UPDATE ON customer_notes
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM customer_notes WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'customer_notes.superseded_by must reference a customer_note in the same tenant')
            END;
          END
        `;

export const v36: Migration = {
    version: 36,
    up: (db) => {
      // customer_note first-class object: a note on a customer, superseding like v35 project_briefs; `customer` is a free-form id (no FK: no entities table).
      // Many notes per customer, each its own supersede chain. Column names were checked against SQLite reserved words.
      if (!tableExists(db, 'customer_notes')) {
        db.exec(CUSTOMER_NOTES_TABLE);
        db.exec(IDX_CUSTOMER_NOTES_TENANT_STATUS);
        db.exec(IDX_CUSTOMER_NOTES_MEMORY);
        db.exec(IDX_CUSTOMER_NOTES_CUSTOMER);
        db.exec(TRG_CUSTOMER_NOTES_TENANT_MATCH_INSERT);
        db.exec(TRG_CUSTOMER_NOTES_TENANT_MATCH_UPDATE);
        db.exec(TRG_CUSTOMER_NOTES_SUPERSEDE_TENANT_MATCH_UPDATE);
      }
    },
};
