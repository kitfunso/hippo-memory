// A store other than hippo.db for the DagReads group: it copies the memory rows out of hippo.db once, then answers each read
// from memory with the scope rule hippo-memory/server exports, so a conformance test shows another store can match hippo.db's SQL.
import { listAuditEventsAfter } from '../../src/audit.js';
import { closeHippoDb, openHippoDb } from '../../src/db.js';
import { passesScopeFilterForRecall, withSqliteAllowed, type AuditEvent, type HippoStore, type MemoryEntry } from '../../src/server.js';
import type { DagReads, SessionRawQuery } from '../../src/store/port.js';
import { MEMORY_SELECT_COLUMNS, rowToEntry, type MemoryRow } from '../../src/store/rows.js';
import { portOnlyStoreWithoutVectorReads } from './port-only-store.js';
import type { StoreSide } from './store-conformance.js';

export interface InMemoryDagReadsStore extends StoreSide {
  readonly store: HippoStore & { readonly dagReads: DagReads };
}

function copyRows(hippoRoot: string): MemoryRow[] {
  return withSqliteAllowed(() => {
    const db = openHippoDb(hippoRoot);
    try {
      // SAFETY: the SELECT names exactly MemoryRow's columns.
      return db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories`).all() as MemoryRow[];
    } finally {
      closeHippoDb(db);
    }
  });
}

// SQLite orders TEXT by its UTF-8 bytes, which localeCompare does not.
const bytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const oldestFirst = (a: MemoryRow, b: MemoryRow): number => bytes(a.created, b.created) || bytes(a.id, b.id);

function sessionRaws(rows: readonly MemoryRow[], { tenantId, sessionId, origins }: SessionRawQuery): MemoryRow[] {
  if (!sessionId) return [];
  return rows
    .filter((r) => r.tenant_id === tenantId && r.kind === 'raw' && r.source_session_id === sessionId && r.superseded_by === null)
    .filter((r) => origins === undefined || r.origin_project === '' || (r.origin_project !== null && origins.includes(r.origin_project)))
    .sort(oldestFirst);
}

export function inMemoryDagReadsStore(hippoRoot: string): InMemoryDagReadsStore {
  const rows = copyRows(hippoRoot);
  const dagReads: DagReads = {
    async sessionRawEntries(query) {
      const all = sessionRaws(rows, query);
      return (query.cap > 0 ? all.slice(-query.cap) : all).map(rowToEntry);
    },
    async sessionRawCount(query) {
      const exact = query.scope !== undefined && query.scope !== '';
      return sessionRaws(rows, query)
        .filter((r) => (exact ? r.scope === query.scope : passesScopeFilterForRecall(r.scope, undefined, query.ownScope)))
        .length;
    },
    async summaryWithDescendants(tenantId, id, { depth, admit }) {
      const mine = rows.filter((r) => r.tenant_id === tenantId);
      const found = mine.find((r) => r.id === id);
      if (!found) return null;
      const summary = rowToEntry(found);
      const levels: MemoryEntry[][] = [];
      const listed = new Set<string>([id]);
      let above = admit(summary) ? [id] : [];
      while (levels.length < depth && above.length > 0) {
        const level: MemoryEntry[] = [];
        for (const parentId of above) {
          for (const child of mine.filter((r) => r.dag_parent_id === parentId).sort(oldestFirst).map(rowToEntry)) {
            if (listed.has(child.id) || !admit(child)) continue;
            listed.add(child.id);
            level.push(child);
          }
        }
        if (level.length === 0) break;
        levels.push(level);
        above = level.map((row) => row.id);
      }
      return { summary, levels };
    },
  };
  const auditRows = (): readonly AuditEvent[] => withSqliteAllowed(() => {
    const db = openHippoDb(hippoRoot);
    try {
      return listAuditEventsAfter(db, { afterId: 0, limit: 10_000 });
    } finally {
      closeHippoDb(db);
    }
  });
  return { store: { ...portOnlyStoreWithoutVectorReads(hippoRoot), kind: 'in-memory', dagReads }, auditRows };
}
