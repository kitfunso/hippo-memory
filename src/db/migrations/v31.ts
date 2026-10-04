import { tableExists } from '../tables.js';
import type { Migration } from './types.js';

export const v31: Migration = {
    version: 31,
    up: (db) => {
      // E2 incident first-class object (docs/plans/2026-05-29-e2-incident-object.md).
      // Mirrors the v30 decisions block but for an open -> resolved -> closed
      // lifecycle (NOT supersede): there is no superseded_by self-FK and no
      // supersede trigger. An incident is a postmortem capsule: a recorded
      // operational event with a lifecycle and optional linked receipts (the
      // memories that are its evidence, stored as a JSON array of ids in
      // linked_memory_ids). The memory mirror is kept for recall but is not
      // authoritative; memory_id is NULLABLE with ON DELETE SET NULL so
      // forget/consolidate/archive does not lose an incident.
      //
      // status (open|resolved|closed): resolved records a resolution_text +
      // resolved_at and stays on record; closed is a terminal retire reachable
      // from open or resolved. Cross-tenant safety: BEFORE INSERT + BEFORE
      // UPDATE triggers enforce incidents.tenant_id == the referenced memory's
      // tenant_id (verbatim mirror of the v30 decisions tenant-match triggers).
      if (!tableExists(db, 'incidents')) {
        db.exec(`
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
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_incidents_tenant_status
          ON incidents(tenant_id, status)
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_incidents_memory
          ON incidents(memory_id) WHERE memory_id IS NOT NULL
        `);
        // Cross-tenant safety vs the referenced memory (verbatim mirror of the
        // v30 decisions tenant-match triggers; no supersede trigger).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_incidents_tenant_match_insert
          BEFORE INSERT ON incidents
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'incidents.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        db.exec(`
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
        `);
      }
    },
};
