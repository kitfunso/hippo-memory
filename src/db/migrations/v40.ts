import type { Migration } from './types.js';

const RECALL_TRACES_SCHEMA_SQL = `
        CREATE TABLE IF NOT EXISTS recall_traces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          session_id TEXT,
          pipeline TEXT NOT NULL CHECK (pipeline IN ('api','cli','context','mcp')),
            -- 'mcp' reserved for the deferred MCP wire-up. Deliberate: SQLite
            -- cannot ALTER a CHECK constraint, so extending it later means a
            -- full table-rebuild migration. One unused enum value now is
            -- cheaper than that rebuild.
          query_hash TEXT NOT NULL,          -- sha256/16, NEVER raw query (audit convention, cli.ts:1532)
          query_length INTEGER NOT NULL,
          result_count INTEGER NOT NULL,
          explain_mode INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_recall_traces_tenant_ts ON recall_traces(tenant_id, ts DESC);

        CREATE TABLE IF NOT EXISTS recall_trace_results (
          trace_id INTEGER NOT NULL REFERENCES recall_traces(id) ON DELETE CASCADE,
          tenant_id TEXT NOT NULL DEFAULT 'default',  -- denormalized like goal_recall_log (v18
                                                      -- precedent): tenant-scoped training queries
                                                      -- over the memory index must not need a join
                                                      -- back through recall_traces
          memory_id TEXT NOT NULL,           -- NO FK to memories: traces must OUTLIVE forgotten
                                             -- memories (they are LC2's negative class). PRAGMA
                                             -- foreign_keys=ON is real, so an FK would either
                                             -- block inserts or cascade-delete exactly the rows
                                             -- training needs. Deliberate.
          result_rank INTEGER NOT NULL,      -- NOT "rank" (SQL keyword; audit rule 10)
          score REAL NOT NULL,
          rerank_json TEXT,                  -- compact RerankStep[] when explain/trace present; else NULL
          PRIMARY KEY (trace_id, result_rank)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_recall_trace_results_tenant_memory
          ON recall_trace_results(tenant_id, memory_id);

        CREATE TABLE IF NOT EXISTS recall_trace_outcomes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trace_id INTEGER NOT NULL REFERENCES recall_traces(id) ON DELETE CASCADE,
          ts TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          outcome TEXT NOT NULL CHECK (outcome IN ('positive','negative')),
          memory_ids_json TEXT NOT NULL      -- ids actually credited by this outcome event
        );
        CREATE INDEX IF NOT EXISTS idx_recall_trace_outcomes_trace ON recall_trace_outcomes(trace_id);
      `;

export const v40: Migration = {
    version: 40,
    up: (db) => {
      // Retrieval-trace persistence: one trace row per recall, a WITHOUT ROWID results table, append-only outcomes (audit_log pruning must not erase them).
      // No min_compatible_binary bump on purpose: old binaries ignore these tables and recordTraceOutcome re-validates trace ids; a bump would lock them out.
      db.exec(RECALL_TRACES_SCHEMA_SQL);
    },
};
