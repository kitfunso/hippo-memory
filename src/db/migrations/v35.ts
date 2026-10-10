import { tableExists } from '../tables.js';
import type { Migration } from './types.js';

const PROJECT_BRIEFS_TABLE = `
          CREATE TABLE project_briefs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            repo TEXT NOT NULL,
            summary TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            change_summary TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES project_briefs(id) ON DELETE SET NULL
          )
        `;

const IDX_PROJECT_BRIEFS_TENANT_STATUS = `
          CREATE INDEX IF NOT EXISTS idx_project_briefs_tenant_status
          ON project_briefs(tenant_id, status)
        `;

const IDX_PROJECT_BRIEFS_MEMORY = `
          CREATE INDEX IF NOT EXISTS idx_project_briefs_memory
          ON project_briefs(memory_id) WHERE memory_id IS NOT NULL
        `;

const IDX_PROJECT_BRIEFS_REPO = `
          CREATE INDEX IF NOT EXISTS idx_project_briefs_repo
          ON project_briefs(tenant_id, repo, status)
        `;

// Cross-tenant safety vs the referenced memory (verbatim mirror of the
// v34 skills tenant-match triggers).
const TRG_PROJECT_BRIEFS_TENANT_MATCH_INSERT = `
          CREATE TRIGGER IF NOT EXISTS trg_project_briefs_tenant_match_insert
          BEFORE INSERT ON project_briefs
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'project_briefs.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `;

const TRG_PROJECT_BRIEFS_TENANT_MATCH_UPDATE = `
          CREATE TRIGGER IF NOT EXISTS trg_project_briefs_tenant_match_update
          BEFORE UPDATE ON project_briefs
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'project_briefs.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `;

// Cross-tenant safety vs the successor brief (self-FK; verbatim mirror of
// the v34 skills supersede trigger).
const TRG_PROJECT_BRIEFS_SUPERSEDE_TENANT_MATCH_UPDATE = `
          CREATE TRIGGER IF NOT EXISTS trg_project_briefs_supersede_tenant_match_update
          BEFORE UPDATE ON project_briefs
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM project_briefs WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'project_briefs.superseded_by must reference a project_brief in the same tenant')
            END;
          END
        `;

export const v35: Migration = {
    version: 35,
    up: (db) => {
      // project_brief first-class object: repo-scoped `summary` superseding like v34 skills; refreshBrief (objects/project-briefs.ts) builds it from receipts.
      // The schema needs only `repo`; column names were checked against SQLite reserved words.
      if (!tableExists(db, 'project_briefs')) {
        db.exec(PROJECT_BRIEFS_TABLE);
        db.exec(IDX_PROJECT_BRIEFS_TENANT_STATUS);
        db.exec(IDX_PROJECT_BRIEFS_MEMORY);
        db.exec(IDX_PROJECT_BRIEFS_REPO);
        db.exec(TRG_PROJECT_BRIEFS_TENANT_MATCH_INSERT);
        db.exec(TRG_PROJECT_BRIEFS_TENANT_MATCH_UPDATE);
        db.exec(TRG_PROJECT_BRIEFS_SUPERSEDE_TENANT_MATCH_UPDATE);
      }
    },
};
