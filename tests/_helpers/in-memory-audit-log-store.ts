// A store other than hippo.db for the AuditLog group: it copies audit_log out of hippo.db once, then keeps the rows in
// memory and filters, orders and pages them itself, so a conformance test shows another store can match hippo.db's SQL.
import { listAuditEventsAfter } from '../../src/store/audit.js';
import { closeHippoDb, openHippoDb } from '../../src/db.js';
import { withSqliteAllowed, type AuditEvent, type HippoStore, type KeysetPosition } from '../../src/server.js';
import type { AuditLog } from '../../src/store/port.js';
import { portOnlyStoreWithoutVectorReads } from './port-only-store.js';
import type { StoreSide } from './store-conformance.js';

export interface InMemoryAuditLogStore extends StoreSide {
  readonly store: HippoStore & { readonly auditLog: AuditLog };
}

function copyRows(hippoRoot: string): AuditEvent[] {
  return withSqliteAllowed(() => {
    const db = openHippoDb(hippoRoot);
    try {
      return listAuditEventsAfter(db, { afterId: 0, limit: 10_000 });
    } finally {
      closeHippoDb(db);
    }
  });
}

// SQLite orders TEXT by its UTF-8 bytes, which localeCompare does not.
const bytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const newestFirst = (a: AuditEvent, b: AuditEvent): number => bytes(b.ts, a.ts) || b.id - a.id;

function isBelow(row: AuditEvent, after: KeysetPosition): boolean {
  const byTs = bytes(row.ts, String(after.key));
  return byTs < 0 || (byTs === 0 && row.id < Number(after.id));
}

export function inMemoryAuditLogStore(hippoRoot: string): InMemoryAuditLogStore {
  const audit = copyRows(hippoRoot);
  let lastId = audit.reduce((high, row) => Math.max(high, row.id), 0);
  const auditLog: AuditLog = {
    async listAuditEvents({ tenantId, op, since, limit, after }) {
      const rows = audit
        .filter((row) => row.tenantId === tenantId && (!op || row.op === op) && (!since || bytes(row.ts, since) >= 0))
        .filter((row) => !after || isBelow(row, after))
        .sort(newestFirst);
      return structuredClone(rows.slice(0, Math.max(1, Math.min(limit ?? 100, 10001))));
    },
  };
  const store: InMemoryAuditLogStore['store'] = {
    ...portOnlyStoreWithoutVectorReads(hippoRoot),
    kind: 'in-memory',
    async appendAuditEvents(events) {
      for (const event of events) {
        lastId += 1;
        const metadata: AuditEvent['metadata'] = JSON.parse(JSON.stringify(event.metadata ?? {}));
        audit.push({ id: lastId, ts: new Date().toISOString(), tenantId: event.tenantId, actor: event.actor, op: event.op, targetId: event.targetId ?? null, metadata });
      }
    },
    auditLog,
  };
  return { store, auditRows: () => structuredClone(audit) };
}
