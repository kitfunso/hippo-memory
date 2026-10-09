import { tableExists } from '../tables.js';
import type { Migration } from './types.js';

const SKILLS_TABLE = `
          CREATE TABLE skills (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            skill_name TEXT NOT NULL,
            instructions TEXT NOT NULL,
            trigger_text TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            change_summary TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES skills(id) ON DELETE SET NULL
          )
        `;

const IDX_SKILLS_TENANT_STATUS = `
          CREATE INDEX IF NOT EXISTS idx_skills_tenant_status
          ON skills(tenant_id, status)
        `;

const IDX_SKILLS_MEMORY = `
          CREATE INDEX IF NOT EXISTS idx_skills_memory
          ON skills(memory_id) WHERE memory_id IS NOT NULL
        `;

// Cross-tenant safety vs the referenced memory (verbatim mirror of the
// v32 processes tenant-match triggers).
const TRG_SKILLS_TENANT_MATCH_INSERT = `
          CREATE TRIGGER IF NOT EXISTS trg_skills_tenant_match_insert
          BEFORE INSERT ON skills
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'skills.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `;

const TRG_SKILLS_TENANT_MATCH_UPDATE = `
          CREATE TRIGGER IF NOT EXISTS trg_skills_tenant_match_update
          BEFORE UPDATE ON skills
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'skills.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `;

// Cross-tenant safety vs the successor skill (self-FK; verbatim mirror of
// the v32 processes supersede trigger).
const TRG_SKILLS_SUPERSEDE_TENANT_MATCH_UPDATE = `
          CREATE TRIGGER IF NOT EXISTS trg_skills_supersede_tenant_match_update
          BEFORE UPDATE ON skills
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM skills WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'skills.superseded_by must reference a skill in the same tenant')
            END;
          END
        `;

export const v34: Migration = {
    version: 34,
    up: (db) => {
      // Skill first-class object.
      // A skill is a reusable, agent-followable capability: an `instructions` body
      // + an optional `trigger_text` (when to apply), evolving via the v32
      // processes supersede machinery (superseded_by self-FK + supersede
      // tenant-match trigger + version + change_summary). This table = the v32
      // processes table MINUS `steps` (a skill's content is a single instructions
      // body) PLUS `instructions` (NOT NULL) and `trigger_text`. "Executable" is
      // scoped to an agent-followable instruction that EXPORTS into the agent's
      // in-force rules (AGENTS.md / CLAUDE.md) via exportSkills; literal code
      // execution is deferred. NOTE: the column is `trigger_text`, NOT `trigger`,
      // because TRIGGER is a SQLite reserved keyword.
      if (!tableExists(db, 'skills')) {
        db.exec(SKILLS_TABLE);
        db.exec(IDX_SKILLS_TENANT_STATUS);
        db.exec(IDX_SKILLS_MEMORY);
        db.exec(TRG_SKILLS_TENANT_MATCH_INSERT);
        db.exec(TRG_SKILLS_TENANT_MATCH_UPDATE);
        db.exec(TRG_SKILLS_SUPERSEDE_TENANT_MATCH_UPDATE);
      }
    },
};
