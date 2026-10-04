import { tableExists } from '../tables.js';
import type { Migration } from './types.js';

export const v32: Migration = {
    version: 32,
    up: (db) => {
      // E2 process first-class object (docs/plans/2026-05-29-e2-process-object.md).
      // A process is a "living process map": a named, ordered list of steps that
      // evolves. Unlike incident (open->resolved->closed, no supersede), process
      // REUSES the v30 decisions supersede path as its delta mechanism: a process
      // evolves by being superseded by a NEW VERSION that records what changed
      // (change_summary) and the full new state (steps), carrying a derived
      // version counter. So this table combines the v31 incidents tenant-match
      // trigger pair (vs the referenced memory) WITH the v30 decisions
      // superseded_by self-FK + supersede tenant-match trigger.
      //
      // status (active|superseded|closed): superseded carries a self-FK
      // superseded_by to the successor version; closed is a terminal
      // retire-without-successor (only an active head closes). The memory mirror
      // is kept for recall but is not authoritative; memory_id is NULLABLE with
      // ON DELETE SET NULL so forget/consolidate/archive does not lose a process.
      // steps is a JSON-encoded array of step strings (scoped v1; a normalized
      // process_steps table is deferred). version is server-derived
      // (predecessor.version + 1); change_summary is set on a successor row only.
      if (!tableExists(db, 'processes')) {
        db.exec(`
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
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_processes_tenant_status
          ON processes(tenant_id, status)
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_processes_memory
          ON processes(memory_id) WHERE memory_id IS NOT NULL
        `);
        // Cross-tenant safety vs the referenced memory (verbatim mirror of the
        // v31 incidents / v30 decisions tenant-match triggers).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_processes_tenant_match_insert
          BEFORE INSERT ON processes
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'processes.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        db.exec(`
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
        `);
        // Cross-tenant safety vs the successor process (self-FK; verbatim mirror
        // of the v30 decisions supersede trigger). superseded_by is set only via
        // the supersede UPDATE; the successor must share the tenant. The successor
        // row already exists in the same transaction when this fires.
        db.exec(`
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
        `);
      }
    },
};
