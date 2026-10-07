import type { Migration } from './types.js';

export const v18: Migration = {
    version: 18,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS goal_stack (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          goal_name TEXT NOT NULL,
          level INTEGER NOT NULL DEFAULT 0
            CHECK (level BETWEEN 0 AND 2),
          parent_goal_id TEXT REFERENCES goal_stack(id) ON DELETE SET NULL,
          status TEXT NOT NULL CHECK (status IN ('active','suspended','completed')),
          success_condition TEXT,
          retrieval_policy_id TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          outcome_score REAL
            CHECK (outcome_score IS NULL OR (outcome_score >= 0 AND outcome_score <= 1))
        );

        CREATE INDEX IF NOT EXISTS idx_goal_stack_tenant_session_status
          ON goal_stack(tenant_id, session_id, status, created_at);

        CREATE TABLE IF NOT EXISTS retrieval_policy (
          id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL REFERENCES goal_stack(id) ON DELETE CASCADE,
          policy_type TEXT NOT NULL CHECK (policy_type IN
            ('schema-fit-biased','error-prioritized','recency-first','hybrid')),
          weight_schema_fit REAL NOT NULL DEFAULT 1.0
            CHECK (weight_schema_fit >= 0 AND weight_schema_fit <= 100),
          weight_recency REAL NOT NULL DEFAULT 1.0
            CHECK (weight_recency >= 0 AND weight_recency <= 100),
          weight_outcome REAL NOT NULL DEFAULT 1.0
            CHECK (weight_outcome >= 0 AND weight_outcome <= 100),
          error_priority REAL NOT NULL DEFAULT 1.0
            CHECK (error_priority >= 0 AND error_priority <= 100)
        );

        CREATE INDEX IF NOT EXISTS idx_retrieval_policy_goal
          ON retrieval_policy(goal_id);

        CREATE TABLE IF NOT EXISTS goal_recall_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          goal_id TEXT NOT NULL REFERENCES goal_stack(id) ON DELETE CASCADE,
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          session_id TEXT NOT NULL,
          recalled_at TEXT NOT NULL,
          score REAL NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_goal_recall_log_goal
          ON goal_recall_log(goal_id);
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_goal_recall_log_memory_goal
          ON goal_recall_log(memory_id, goal_id);
      `);
    },
};
