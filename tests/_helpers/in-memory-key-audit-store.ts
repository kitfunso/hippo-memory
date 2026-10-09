// A store other than hippo.db for the KeyAudit group: it copies api_keys and audit_log out of hippo.db once, then keeps
// both in memory and answers with what hippo-memory/server exports, so a conformance test shows that is all another store needs.
import { closeHippoDb, openHippoDb } from '../../src/db.js';
import { listAuditEventsAfter } from '../../src/store/audit.js';
import { readApiKeyRecord } from '../../src/store/auth.js';
import { auditHighIdAt } from '../../src/store/key-audit.js';
import {
  NotFoundError,
  type ApiKeyRecord, type AppendAuditOpts, type AuditEvent, type HippoStore, type KeyAudit, type ListAuditAfterOpts,
} from '../../src/server.js';
import type { StoreSide } from './store-conformance.js';
import { portOnlyStoreWithoutVectorReads } from './port-only-store.js';

export interface InMemoryKeyAuditStore extends StoreSide {
  readonly store: HippoStore & { readonly keyAudit: KeyAudit };
}

interface CopiedRows {
  readonly keys: Map<string, ApiKeyRecord>;
  readonly audit: AuditEvent[];
  readonly highId: number;
}

function copyRows(hippoRoot: string): CopiedRows {
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: the SELECT names one column, key_id.
    const ids = db.prepare('SELECT key_id FROM api_keys').all() as { key_id: string }[];
    const keys = new Map(ids.flatMap(({ key_id }): [string, ApiKeyRecord][] => {
      const record = readApiKeyRecord(db, key_id);
      return record ? [[key_id, record]] : [];
    }));
    return { keys, audit: listAuditEventsAfter(db, { afterId: 0, limit: 10_000 }), highId: auditHighIdAt(db) };
  } finally {
    closeHippoDb(db);
  }
}

/** listAuditEventsAfter's checks and clamp, which every store owes its callers. */
function checkedLimit(opts: ListAuditAfterOpts): number {
  if (!Number.isInteger(opts.afterId) || opts.afterId < 0) throw new RangeError('afterId must be a non-negative integer');
  if (opts.limit !== undefined && !Number.isInteger(opts.limit)) throw new RangeError('limit must be an integer');
  return Math.max(1, Math.min(opts.limit ?? 1000, 10000));
}

export function inMemoryKeyAuditStore(hippoRoot: string): InMemoryKeyAuditStore {
  const { keys, audit, highId } = copyRows(hippoRoot);
  let lastId = highId;
  const append = (event: AppendAuditOpts): void => {
    lastId += 1;
    const metadata: AuditEvent['metadata'] = JSON.parse(JSON.stringify(event.metadata ?? {}));
    audit.push({ id: lastId, ts: new Date().toISOString(), tenantId: event.tenantId, actor: event.actor, op: event.op, targetId: event.targetId ?? null, metadata });
  };
  const keyAudit: KeyAudit = {
    async revokeApiKey({ tenantId, keyId, actor, at }) {
      const key = keys.get(keyId);
      if (!key || key.tenantId !== tenantId) throw new NotFoundError(`Unknown key_id: ${keyId}`);
      if (key.revokedAt) return key.revokedAt;
      keys.set(keyId, { ...key, revokedAt: at });
      append({ tenantId: key.tenantId, actor, op: 'auth_revoke', targetId: keyId });
      return at;
    },
    async auditEventsAfter(opts) {
      const limit = checkedLimit(opts);
      const rows = audit.filter((e) => e.id > opts.afterId && (opts.tenantId === undefined || e.tenantId === opts.tenantId));
      return structuredClone(rows.slice(0, limit));
    },
    async auditHighId() {
      return lastId;
    },
  };
  const store: InMemoryKeyAuditStore['store'] = {
    ...portOnlyStoreWithoutVectorReads(hippoRoot),
    kind: 'in-memory',
    async findApiKey(keyId) {
      const key = keys.get(keyId);
      return key ? structuredClone(key) : null;
    },
    async appendAuditEvents(events) {
      for (const event of events) append(event);
    },
    keyAudit,
  };
  return { store, auditRows: () => structuredClone(audit) };
}
