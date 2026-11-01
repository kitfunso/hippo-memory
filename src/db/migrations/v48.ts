import type { Migration } from './types.js';

const MEMORY_QUARANTINE_DDL = `
    CREATE TABLE IF NOT EXISTS memory_quarantine (
      tenant_id      TEXT NOT NULL DEFAULT 'default',
      memory_id      TEXT NOT NULL,
      original_scope TEXT,
      reason         TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      quarantined_at TEXT NOT NULL,
      decided_at     TEXT,
      decided_by     TEXT,
      PRIMARY KEY (tenant_id, memory_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_memory_quarantine_status
      ON memory_quarantine(tenant_id, status, quarantined_at DESC);
`;

export const v48: Migration = {
  version: 48,
  up: (db) => {
    // Quarantine (src/domain/trust/quarantine.ts) holds a suspect memory for admin review rather
    // than hiding it with no record. Additive only: no min_compatible_binary bump.
    db.exec(MEMORY_QUARANTINE_DDL);
  },
};
