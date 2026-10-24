import type { Migration } from './types.js';

const CONFLICTED = `idx_memories_conflicted ON memories(id) WHERE conflicts_with_json != '[]'`;
const TRACES_BY_TS = 'idx_recall_traces_ts ON recall_traces(ts)';

export const v63: Migration = {
  version: 63,
  up: (db) => {
    // The WHERE repeats the conflict refresh's own term, so SQLite can prove the index holds every row that read wants.
    db.exec(`CREATE INDEX IF NOT EXISTS ${CONFLICTED}`);
    // The trace prune reads by ts alone, which idx_recall_traces_tenant_ts cannot serve: it leads with tenant_id.
    db.exec(`CREATE INDEX IF NOT EXISTS ${TRACES_BY_TS}`);
  },
};
