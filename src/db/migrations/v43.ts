import type { Migration } from './types.js';

export const v43: Migration = {
    version: 43,
    up: (db) => {
      // W2a work-queue cards (trajectories/01M2D5VSYJFK4YXQ0RG2NGCPYJ/plan.md). Additive only, v41 precedent.
      db.exec(`
        CREATE TABLE IF NOT EXISTS cards (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'backlog',
          assignee_runtime TEXT,
          repo TEXT,
          contract TEXT,
          budget INTEGER,
          lease_until TEXT,
          heartbeat_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          scope TEXT
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_cards_tenant_status
          ON cards(tenant_id, status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS card_deps (
          parent TEXT NOT NULL REFERENCES cards(id),
          child TEXT NOT NULL REFERENCES cards(id),
          tenant_id TEXT NOT NULL DEFAULT 'default',
          created_at TEXT NOT NULL,
          PRIMARY KEY (parent, child)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_card_deps_tenant_child
          ON card_deps(tenant_id, child);
        CREATE INDEX IF NOT EXISTS idx_card_deps_tenant_parent
          ON card_deps(tenant_id, parent);

        CREATE TABLE IF NOT EXISTS card_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          card TEXT NOT NULL REFERENCES cards(id),
          runtime TEXT NOT NULL,
          session_id TEXT,
          started TEXT NOT NULL,
          ended TEXT,
          outcome TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default'
        );
        CREATE INDEX IF NOT EXISTS idx_card_runs_tenant_card
          ON card_runs(tenant_id, card, started DESC);

        CREATE TABLE IF NOT EXISTS card_comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          card_id TEXT NOT NULL REFERENCES cards(id),
          author TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default'
        );
        CREATE INDEX IF NOT EXISTS idx_card_comments_tenant_card
          ON card_comments(tenant_id, card_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_session_handoffs_tenant_card
          ON session_handoffs(tenant_id, card_id, created_at DESC);
      `);
    },
};
