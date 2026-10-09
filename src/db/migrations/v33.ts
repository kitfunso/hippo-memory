import { tableExists } from '../tables.js';
import type { Migration } from './types.js';

const POLICIES_TABLE = `
          CREATE TABLE policies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            policy_name TEXT NOT NULL,
            policy_text TEXT NOT NULL,
            valid_from TEXT NOT NULL,
            valid_to TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            change_summary TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES policies(id) ON DELETE SET NULL
          )
        `;

const IDX_POLICIES_TENANT_STATUS = `
          CREATE INDEX IF NOT EXISTS idx_policies_tenant_status
          ON policies(tenant_id, status)
        `;

const IDX_POLICIES_MEMORY = `
          CREATE INDEX IF NOT EXISTS idx_policies_memory
          ON policies(memory_id) WHERE memory_id IS NOT NULL
        `;

// Supports the as-of query (active policies in force at a valid-time).
const IDX_POLICIES_ASOF = `
          CREATE INDEX IF NOT EXISTS idx_policies_asof
          ON policies(tenant_id, valid_from)
        `;

// Cross-tenant safety vs the referenced memory (verbatim mirror of the
// v32 processes tenant-match triggers).
const TRG_POLICIES_TENANT_MATCH_INSERT = `
          CREATE TRIGGER IF NOT EXISTS trg_policies_tenant_match_insert
          BEFORE INSERT ON policies
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'policies.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `;

const TRG_POLICIES_TENANT_MATCH_UPDATE = `
          CREATE TRIGGER IF NOT EXISTS trg_policies_tenant_match_update
          BEFORE UPDATE ON policies
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'policies.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `;

// Cross-tenant safety vs the successor policy (self-FK; verbatim mirror of
// the v32 processes supersede trigger).
const TRG_POLICIES_SUPERSEDE_TENANT_MATCH_UPDATE = `
          CREATE TRIGGER IF NOT EXISTS trg_policies_supersede_tenant_match_update
          BEFORE UPDATE ON policies
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM policies WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'policies.superseded_by must reference a policy in the same tenant')
            END;
          END
        `;

export const v33: Migration = {
    version: 33,
    up: (db) => {
      // Policy first-class object.
      // The "bi-temporal-first" object type: a named rule/statement that is in
      // force over an EFFECTIVE-TIME range (valid_from required, valid_to nullable
      // = open-ended) and evolves via the v32 processes supersede machinery
      // (superseded_by self-FK + supersede tenant-match trigger + version +
      // change_summary). This table = the v32 processes table MINUS `steps`
      // (a policy has policy_text, not an ordered step list) PLUS the first-class
      // effective-time columns valid_from/valid_to. Valid-time is the queryable
      // axis (the as-of query loadPoliciesAsOf); transaction-time is present via
      // created_at + the supersede chain's superseded_at (time-travel deferred).
      //
      // All date inputs are normalized to standard ISO-8601 datetime
      // (toISOString) at the store boundary before persist/compare, so the
      // fixed-width values sort lexically and the half-open [valid_from, valid_to)
      // as-of comparison is correct.
      if (!tableExists(db, 'policies')) {
        db.exec(POLICIES_TABLE);
        db.exec(IDX_POLICIES_TENANT_STATUS);
        db.exec(IDX_POLICIES_MEMORY);
        db.exec(IDX_POLICIES_ASOF);
        db.exec(TRG_POLICIES_TENANT_MATCH_INSERT);
        db.exec(TRG_POLICIES_TENANT_MATCH_UPDATE);
        db.exec(TRG_POLICIES_SUPERSEDE_TENANT_MATCH_UPDATE);
      }
    },
};
