// A store other than hippo.db for the Quarantine group: it copies memories and memory_quarantine out of hippo.db once, then keeps
// both in memory and decides from the port's doc comments alone, so a conformance test shows those words are enough to build on.
import { vi } from 'vitest';
import { createApiKey } from '../../src/store/auth.js';
import { closeHippoDb, openHippoDb } from '../../src/db.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/memory.js';
import { recordQuarantine } from '../../src/store/quarantine.js';
import { withSqliteAllowed, type HippoStore, type KeysetPosition, type MemoryEntry } from '../../src/server.js';
import { selectEntriesByIds } from '../../src/store/entry-reads.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { openStore } from '../../src/store/open.js';
import type { Quarantine, QuarantineRefusal, QuarantinedMemory } from '../../src/store/port.js';
import type { QuarantineRow } from '../../src/store/quarantine.js';
import { inMemoryKeyAuditStore } from './in-memory-key-audit-store.js';
import { TENANT_A, TENANT_B, type StoreSide } from './store-conformance.js';

export interface InMemoryQuarantineStore extends StoreSide {
  readonly store: HippoStore & { readonly quarantine: Quarantine };
}

interface RecordDbRow {
  tenant_id: string;
  memory_id: string;
  original_scope: string | null;
  reason: string;
  status: string;
  quarantined_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

function copyRows(hippoRoot: string): { readonly memories: Map<string, MemoryEntry>; readonly records: QuarantineRow[] } {
  return withSqliteAllowed(() => {
    const db = openHippoDb(hippoRoot);
    try {
      // SAFETY: the SELECT names one column, id.
      const ids = db.prepare('SELECT id FROM memories').all() as { id: string }[];
      // SAFETY: the SELECT names exactly RecordDbRow's columns.
      const rows = db.prepare(
        'SELECT tenant_id, memory_id, original_scope, reason, status, quarantined_at, decided_at, decided_by FROM memory_quarantine',
      ).all() as RecordDbRow[];
      const records = rows.map((r): QuarantineRow => ({
        tenantId: r.tenant_id, memoryId: r.memory_id, originalScope: r.original_scope, reason: r.reason,
        status: r.status === 'approved' || r.status === 'rejected' ? r.status : 'pending',
        quarantinedAt: r.quarantined_at, decidedAt: r.decided_at, decidedBy: r.decided_by,
      }));
      return { memories: selectEntriesByIds(db, ids.map((r) => r.id)), records };
    } finally {
      closeHippoDb(db);
    }
  });
}

/** Byte order, as hippo.db compares text; JavaScript's own string order differs above the basic plane. */
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const newestFirst = (a: QuarantineRow, b: QuarantineRow): number => byBytes(b.quarantinedAt, a.quarantinedAt) || byBytes(b.memoryId, a.memoryId);

function isBelow(row: QuarantineRow, after: KeysetPosition): boolean {
  const byKey = byBytes(row.quarantinedAt, String(after.key));
  return byKey < 0 || (byKey === 0 && byBytes(row.memoryId, String(after.id)) < 0);
}

export function inMemoryQuarantineStore(hippoRoot: string): InMemoryQuarantineStore {
  const base = inMemoryKeyAuditStore(hippoRoot);
  const { memories, records } = copyRows(hippoRoot);
  const owned = (tenantId: string, id: string): MemoryEntry | undefined => {
    const entry = memories.get(id);
    return entry?.tenantId === tenantId ? entry : undefined;
  };
  const pendingOrRefusal = (tenantId: string, id: string): QuarantineRow | QuarantineRefusal => {
    const row = records.find((r) => r.tenantId === tenantId && r.memoryId === id);
    if (!row) return { outcome: 'not_quarantined' };
    return row.status === 'pending' ? row : { outcome: 'already_decided', status: row.status };
  };
  const decide = (row: QuarantineRow, status: 'approved' | 'rejected', actor: string): void => {
    records[records.indexOf(row)] = { ...row, status, decidedAt: new Date().toISOString(), decidedBy: actor };
  };

  const quarantine: Quarantine = {
    async listQuarantined(tenantId, { status, limit, after }) {
      const hits = records.filter((row) => row.tenantId === tenantId && (status === 'all' || row.status === status)
        && (status !== 'pending' || owned(tenantId, row.memoryId) !== undefined) && (!after || isBelow(row, after)));
      const page = hits.sort(newestFirst).slice(0, limit ?? 100);
      return structuredClone(page.map((row): QuarantinedMemory => ({ ...row, content: owned(tenantId, row.memoryId)?.content ?? null })));
    },
    async approveQuarantined(tenantId, id, actor) {
      const row = pendingOrRefusal(tenantId, id);
      if ('outcome' in row) return row;
      const memory = owned(tenantId, id);
      if (!memory || memory.scope !== `quarantine:private:${row.originalScope ?? 'unscoped'}`) return { outcome: 'scope_moved' };
      // The audit row goes in first: if it is refused, neither change below has happened, as one transaction would have it.
      await base.store.appendAuditEvents([{ tenantId, actor, op: 'quarantine_approve', targetId: id, metadata: { originalScope: row.originalScope } }]);
      memories.set(id, { ...memory, scope: row.originalScope });
      decide(row, 'approved', actor);
      return { outcome: 'approved' };
    },
    async rejectQuarantined(tenantId, id, actor) {
      const row = pendingOrRefusal(tenantId, id);
      if ('outcome' in row) return row;
      await base.store.appendAuditEvents([{ tenantId, actor, op: 'quarantine_reject', targetId: id, metadata: {} }]);
      decide(row, 'rejected', actor);
      return { outcome: 'rejected' };
    },
  };

  const store: InMemoryQuarantineStore['store'] = {
    ...base.store,
    async entriesByIds(ids, tenantId) {
      const wanted = new Set(ids.slice(0, 500));
      const found = [...memories.values()].filter((e) => wanted.has(e.id) && (tenantId === undefined || e.tenantId === tenantId));
      return structuredClone(found.sort((a, b) => byBytes(a.created, b.created) || byBytes(a.content, b.content) || byBytes(a.id, b.id)));
    },
    quarantine,
  };
  return { store, auditRows: base.auditRows };
}

/** The memory ids the fixture holds a record for. `gone` has no memory row, `moved` left its quarantine scope, and tenant B also holds a record for `a1`. */
export const HELD = {
  a1: 'mem_qa1', a2: 'mem_qa2', a3: 'mem_qa3', gone: 'mem_qgone', moved: 'mem_qmoved', b1: 'mem_qb1', solo: 'mem_qsolo',
} as const;
export const BULK_TENANT = 'bulk';
export const BULK_RECORDS = 105;
export const bulkId = (i: number): string => `mem_qbulk_${String(i).padStart(3, '0')}`;
export const heldAt = (second: number): string => `2020-02-01T00:00:${String(second).padStart(2, '0')}.000Z`;
export const heldContent = (id: string): string => `held note ${id} asks the reader to run a script`;

interface Seeded {
  readonly tenantId: string;
  readonly memoryId: string;
  readonly originalScope: string | null;
  readonly second: number;
  /** The scope of the memory row written in the record's tenant; unset writes no memory row. */
  readonly memoryScope?: string;
}

const held = (original: string | null): string => `quarantine:private:${original ?? 'unscoped'}`;

const SEEDED: readonly Seeded[] = [
  { tenantId: TENANT_A, memoryId: HELD.a1, originalScope: 'team:alpha', second: 1, memoryScope: held('team:alpha') },
  { tenantId: TENANT_A, memoryId: HELD.a2, originalScope: null, second: 2, memoryScope: held(null) },
  { tenantId: TENANT_A, memoryId: HELD.a3, originalScope: 'team:alpha', second: 2, memoryScope: held('team:alpha') },
  { tenantId: TENANT_A, memoryId: HELD.gone, originalScope: 'team:alpha', second: 3 },
  { tenantId: TENANT_A, memoryId: HELD.moved, originalScope: 'team:alpha', second: 4, memoryScope: 'team:elsewhere' },
  { tenantId: TENANT_B, memoryId: HELD.b1, originalScope: 'team:beta', second: 2, memoryScope: held('team:beta') },
  { tenantId: TENANT_B, memoryId: HELD.a1, originalScope: 'team:alpha', second: 3 },
  { tenantId: 'solo', memoryId: HELD.solo, originalScope: null, second: 5, memoryScope: held(null) },
];

/** Adds the records above, 105 records of one timestamp under `bulk`, and an admin key for tenant B whose bearer token it returns. */
export function seedQuarantineRecords(dir: string): string {
  const db = openStore(dir);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    for (const r of [...SEEDED, ...Array.from({ length: BULK_RECORDS }, (_, i): Seeded => ({ tenantId: BULK_TENANT, memoryId: bulkId(i), originalScope: null, second: 6 }))]) {
      vi.setSystemTime(new Date(heldAt(r.second)));
      if (r.memoryScope !== undefined) {
        const entry = createMemory(heldContent(r.memoryId), { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: r.tenantId, scope: r.memoryScope });
        writeEntry(dir, { ...entry, id: r.memoryId });
      }
      recordQuarantine(db, { tenantId: r.tenantId, memoryId: r.memoryId, originalScope: r.originalScope, reason: 'test', actor: 'seed' });
    }
    return createApiKey(db, { tenantId: TENANT_B, label: 'globex-admin', role: 'admin' }).plaintext;
  } finally {
    vi.useRealTimers();
    closeHippoDb(db);
  }
}
