import { tableExists } from '../tables.js';
import type { Migration } from './types.js';

const OBJECT_TABLES = [
  'decisions',
  'incidents',
  'processes',
  'policies',
  'skills',
  'project_briefs',
  'customer_notes',
] as const;

export const v56: Migration = {
    version: 56,
    up: (db) => {
      // The list order is part of the key, so a page by status reads in index order with no sort; the old (tenant_id,
      // status) index stays.
      for (const table of OBJECT_TABLES) {
        if (!tableExists(db, table)) continue;
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_${table}_tenant_status_created ` +
            `ON ${table}(tenant_id, status, created_at DESC, id DESC)`,
        );
      }
      // Source leads so a tenant-only query cannot pick this over idx_memories_tenant_created and change the order of
      // its unsorted rows;
      // created and id let a per-source read come back in store order with no sort.
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_memories_source_tenant_created ON memories(source, tenant_id, created, id)',
      );
    },
};
