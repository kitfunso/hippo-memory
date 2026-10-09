// Quarantine answers alike on hippo.db and on a store held in memory: the same records, the same order, the same refusals and the same audit rows.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent } from '../src/store/audit.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import type { KeysetPosition } from '../src/util/keyset.js';
import { sqliteStore } from '../src/store/index.js';
import { auditHighIdAt } from '../src/store/key-audit.js';
import type { QuarantineApproval, QuarantineListQuery, QuarantineRejection, QuarantinedMemory } from '../src/store/port.js';
import {
  BULK_RECORDS, BULK_TENANT, bulkId, HELD, heldAt, heldContent, inMemoryQuarantineStore, seedQuarantineRecords,
} from './_helpers/in-memory-quarantine-store.js';
import { onBothStores, seedTwoTenants, TENANT_A, TENANT_B, type GroupCall, type SideResult, type TwoTenantFixture } from './_helpers/store-conformance.js';

const NOW = '2026-03-01T12:00:00.000Z';
const T1 = '2026-03-01T12:00:01.000Z';
const T2 = '2026-03-01T12:00:02.000Z';
const ACTOR = 'api_key:reviewer';
const ALPHA_HELD = 'quarantine:private:team:alpha';

/** A memory row as a caller can tell where it sits. */
interface ScopeView {
  readonly id: string;
  readonly scope: string | null;
}

type Value = QuarantinedMemory[] | string[] | string[][] | ScopeView[] | QuarantineApproval | QuarantineRejection;
type Call = GroupCall<'quarantine', Value>;
type Side = SideResult<Value>;

let fixture: TwoTenantFixture;
let baseline: Side;
let nextAuditId: number;

async function conforms(calls: readonly Call[]): Promise<Side> {
  const sides = await onBothStores(fixture, 'quarantine', inMemoryQuarantineStore, calls);
  expect(sides.other).toEqual(sides.sqlite);
  return sides.sqlite;
}

/** Sets the clock inside the call, so each store reads the same time at the same step. */
const at = (iso: string, call: Call): Call => (g, store) => {
  vi.setSystemTime(new Date(iso));
  return call(g, store);
};
const all = (query: Partial<QuarantineListQuery> = {}): QuarantineListQuery => ({ status: 'all', ...query });
const list = (query: QuarantineListQuery, tenantId = TENANT_A): Call => (g) => g.listQuarantined(tenantId, query);
const ids = (query: QuarantineListQuery, tenantId = TENANT_A): Call => async (g) => (await g.listQuarantined(tenantId, query)).map((r) => r.memoryId);
const approve = (id: string, tenantId = TENANT_A): Call => (g) => g.approveQuarantined(tenantId, id, ACTOR);
const reject = (id: string, tenantId = TENANT_A): Call => (g) => g.rejectQuarantined(tenantId, id, ACTOR);
const scopeOf = (id: string, tenantId = TENANT_A): Call => async (_g, store) =>
  (await store.entriesByIds([id], tenantId)).map((e) => ({ id: e.id, scope: e.scope ?? null }));
const below = (second: number, id: string): KeysetPosition => ({ key: heldAt(second), id });

/** Every page of `limit` records, each resumed from the last record of the one before, until a page comes back empty. */
const pages = (limit: number, tenantId = TENANT_A): Call => async (g) => {
  const read: string[][] = [];
  let after: KeysetPosition | undefined;
  for (;;) {
    const page = await g.listQuarantined(tenantId, all({ limit, after }));
    const last = page[page.length - 1];
    if (!last) return read;
    read.push(page.map((r) => r.memoryId));
    after = { key: last.quarantinedAt, id: last.memoryId };
  }
};

function pending(memoryId: string, originalScope: string | null, second: number, content: string | null, tenantId = TENANT_A): QuarantinedMemory {
  return { tenantId, memoryId, originalScope, reason: 'test', status: 'pending', quarantinedAt: heldAt(second), decidedAt: null, decidedBy: null, content };
}

const values = (side: Side): Value[] => side.outcomes.map((o) => {
  if ('error' in o) throw new Error(o.error);
  return o.value;
});

/** The rows a run added, each under the next audit id in turn. */
const added = (side: Side): AuditEvent[] => side.audit.slice(baseline.audit.length);

function auditRow(nth: number, ts: string, op: AuditEvent['op'], targetId: string, metadata: AuditEvent['metadata'], tenantId = TENANT_A): AuditEvent {
  return { id: nextAuditId + nth, ts, tenantId, actor: ACTOR, op, targetId, metadata };
}

const A_PENDING = [HELD.moved, HELD.a3, HELD.a2, HELD.a1];
const A_ALL = [HELD.moved, HELD.gone, HELD.a3, HELD.a2, HELD.a1];
const BULK_IDS = Array.from({ length: BULK_RECORDS }, (_, i) => bulkId(BULK_RECORDS - 1 - i));
/** Everything a refused decision could have touched, read through the port. */
const STATE: readonly Call[] = [list(all()), list(all(), TENANT_B), scopeOf(HELD.a1), scopeOf(HELD.a2), scopeOf(HELD.moved), scopeOf(HELD.b1, TENANT_B)];

beforeAll(async () => {
  fixture = seedTwoTenants();
  seedQuarantineRecords(fixture.dir);
  const db = openHippoDb(fixture.dir);
  try {
    nextAuditId = auditHighIdAt(db) + 1;
  } finally {
    closeHippoDb(db);
  }
  // Unasserted here, so a store that disagrees fails the test that reads the state and not the whole file.
  baseline = (await onBothStores(fixture, 'quarantine', inMemoryQuarantineStore, STATE)).sqlite;
}, 60_000);

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Quarantine.listQuarantined', () => {
  it('reads nothing for a tenant with no record, and the whole record of a one-record tenant with its memory content', async () => {
    const side = await conforms([list({ status: 'pending' }, 'nobody'), list(all(), 'nobody'), list({ status: 'pending' }, 'solo')]);
    expect(values(side)).toEqual([[], [], [pending(HELD.solo, null, 5, heldContent(HELD.solo), 'solo')]]);
    expect(added(side)).toEqual([]);
  });

  it("lists a tenant newest first, by memory id inside a shared timestamp, and never another tenant's records", async () => {
    const side = await conforms([ids({ status: 'pending' }), ids(all()), ids({ status: 'pending' }, TENANT_B), ids(all(), TENANT_B)]);
    expect(values(side)).toEqual([A_PENDING, A_ALL, [HELD.b1], [HELD.a1, HELD.b1]]);
  });

  it('leaves a record out of pending once its memory row is gone from the tenant, and reads it elsewhere with null content', async () => {
    const side = await conforms([list(all({ limit: 2 })), list(all({ limit: 1 }), TENANT_B)]);
    expect(values(side)).toEqual([
      [pending(HELD.moved, 'team:alpha', 4, heldContent(HELD.moved)), pending(HELD.gone, 'team:alpha', 3, null)],
      [pending(HELD.a1, 'team:alpha', 3, null, TENANT_B)],
    ]);
  });

  it('keeps the newest records at, under and over the limit', async () => {
    const n = A_ALL.length;
    const side = await conforms([ids(all({ limit: n })), ids(all({ limit: n - 1 })), ids(all({ limit: n + 1 })), ids(all({ limit: 1 })), ids({ status: 'pending', limit: 2 })]);
    expect(values(side)).toEqual([A_ALL, A_ALL.slice(0, n - 1), A_ALL, [HELD.moved], [HELD.moved, HELD.a3]]);
  });

  it('reads 100 records with no limit given, and every record at and above the count', async () => {
    const side = await conforms([ids(all(), BULK_TENANT), ids(all({ limit: 100 }), BULK_TENANT), ids(all({ limit: BULK_RECORDS }), BULK_TENANT), ids(all({ limit: 1000 }), BULK_TENANT)]);
    expect(values(side)).toEqual([BULK_IDS.slice(0, 100), BULK_IDS.slice(0, 100), BULK_IDS, BULK_IDS]);
  });

  it('narrows by status once records are decided', async () => {
    const side = await conforms([
      approve(HELD.a1), reject(HELD.a2), reject(HELD.gone),
      ids({ status: 'approved' }), ids({ status: 'rejected' }), ids({ status: 'pending' }), ids(all()), ids({ status: 'approved' }, TENANT_B),
    ]);
    expect(values(side).slice(3)).toEqual([[HELD.a1], [HELD.gone, HELD.a2], [HELD.moved, HELD.a3], A_ALL, []]);
  });

  it('resumes below a position alone, between two records sharing a timestamp and inside the asking tenant', async () => {
    const side = await conforms([
      ids(all({ after: below(2, HELD.a3) })), ids(all({ after: below(2, 'mem_qzzz') })), ids(all({ after: below(1, HELD.a1) })),
      ids({ status: 'pending', after: below(4, HELD.moved) }), ids(all({ after: below(3, HELD.a1) }), TENANT_B),
    ]);
    expect(values(side)).toEqual([[HELD.a2, HELD.a1], [HELD.a3, HELD.a2, HELD.a1], [], [HELD.a3, HELD.a2, HELD.a1], [HELD.b1]]);
  });

  it('pages by cursor with no record twice and none missed, a page boundary falling inside a shared timestamp', async () => {
    const side = await conforms([pages(3), pages(2), pages(1), pages(50, BULK_TENANT), pages(4, 'nobody')]);
    expect(values(side)).toEqual([
      [A_ALL.slice(0, 3), A_ALL.slice(3)],
      [A_ALL.slice(0, 2), A_ALL.slice(2, 4), A_ALL.slice(4)],
      A_ALL.map((id) => [id]),
      [BULK_IDS.slice(0, 50), BULK_IDS.slice(50, 100), BULK_IDS.slice(100)],
      [],
    ]);
  });
});

describe('Quarantine.approveQuarantined', () => {
  it('puts the memory back under its original scope, a null one included, marks the record and appends one quarantine_approve row each', async () => {
    const side = await conforms([
      at(T1, approve(HELD.a1)), at(T2, approve(HELD.a2)), scopeOf(HELD.a1), scopeOf(HELD.a2), list({ status: 'approved' }), scopeOf(HELD.a3),
    ]);
    const decided = (row: QuarantinedMemory, decidedAt: string): QuarantinedMemory => ({ ...row, status: 'approved', decidedAt, decidedBy: ACTOR });
    expect(values(side)).toEqual([
      { outcome: 'approved' }, { outcome: 'approved' }, [{ id: HELD.a1, scope: 'team:alpha' }], [{ id: HELD.a2, scope: null }],
      [decided(pending(HELD.a2, null, 2, heldContent(HELD.a2)), T2), decided(pending(HELD.a1, 'team:alpha', 1, heldContent(HELD.a1)), T1)],
      [{ id: HELD.a3, scope: ALPHA_HELD }],
    ]);
    expect(added(side)).toEqual([
      auditRow(0, T1, 'quarantine_approve', HELD.a1, { originalScope: 'team:alpha' }),
      auditRow(1, T2, 'quarantine_approve', HELD.a2, { originalScope: null }),
    ]);
  });

  it("refuses an unknown id, another tenant's id, a memory moved out of its quarantine scope, one gone and one in another tenant, writing nothing", async () => {
    const side = await conforms([
      approve('mem_unknown'), approve(HELD.a2, TENANT_B), approve(HELD.b1), approve(HELD.moved), approve(HELD.gone), approve(HELD.a1, TENANT_B), ...STATE,
    ]);
    expect(values(side).slice(0, 6)).toEqual([
      { outcome: 'not_quarantined' }, { outcome: 'not_quarantined' }, { outcome: 'not_quarantined' },
      { outcome: 'scope_moved' }, { outcome: 'scope_moved' }, { outcome: 'scope_moved' },
    ]);
    expect(side.outcomes.slice(6)).toEqual(baseline.outcomes);
    expect(added(side)).toEqual([]);
  });

  it('refuses a record decided before, and the first decision stands', async () => {
    const side = await conforms([
      at(T1, approve(HELD.a1)), at(T2, approve(HELD.a1)), at(T1, reject(HELD.a3)), at(T2, approve(HELD.a3)), list({ status: 'approved' }), scopeOf(HELD.a3),
    ]);
    const [, again, , afterReject, approved, a3] = values(side);
    expect([again, afterReject]).toEqual([{ outcome: 'already_decided', status: 'approved' }, { outcome: 'already_decided', status: 'rejected' }]);
    expect(approved).toEqual([{ ...pending(HELD.a1, 'team:alpha', 1, heldContent(HELD.a1)), status: 'approved', decidedAt: T1, decidedBy: ACTOR }]);
    expect(a3).toEqual([{ id: HELD.a3, scope: ALPHA_HELD }]);
    expect(added(side).map((e) => [e.op, e.targetId, e.ts])).toEqual([['quarantine_approve', HELD.a1, T1], ['quarantine_reject', HELD.a3, T1]]);
  });
});

describe('Quarantine.rejectQuarantined', () => {
  it('marks the record, leaves the memory under its quarantine scope and appends one quarantine_reject row, with or without a memory row', async () => {
    const side = await conforms([
      at(T1, reject(HELD.a1)), at(T2, reject(HELD.gone)), at(T2, reject(HELD.a1, TENANT_B)), scopeOf(HELD.a1), list({ status: 'rejected' }), ids({ status: 'rejected' }, TENANT_B),
    ]);
    const decided = (row: QuarantinedMemory, decidedAt: string): QuarantinedMemory => ({ ...row, status: 'rejected', decidedAt, decidedBy: ACTOR });
    expect(values(side)).toEqual([
      { outcome: 'rejected' }, { outcome: 'rejected' }, { outcome: 'rejected' }, [{ id: HELD.a1, scope: ALPHA_HELD }],
      [decided(pending(HELD.gone, 'team:alpha', 3, null), T2), decided(pending(HELD.a1, 'team:alpha', 1, heldContent(HELD.a1)), T1)],
      [HELD.a1],
    ]);
    expect(added(side)).toEqual([
      auditRow(0, T1, 'quarantine_reject', HELD.a1, {}),
      auditRow(1, T2, 'quarantine_reject', HELD.gone, {}),
      auditRow(2, T2, 'quarantine_reject', HELD.a1, {}, TENANT_B),
    ]);
  });

  it("refuses an unknown id and another tenant's id, writing nothing", async () => {
    const side = await conforms([reject('mem_unknown'), reject(HELD.a2, TENANT_B), reject(HELD.b1), ...STATE]);
    expect(values(side).slice(0, 3)).toEqual([{ outcome: 'not_quarantined' }, { outcome: 'not_quarantined' }, { outcome: 'not_quarantined' }]);
    expect(side.outcomes.slice(3)).toEqual(baseline.outcomes);
    expect(added(side)).toEqual([]);
  });

  it('refuses a record decided before, and the first decision stands', async () => {
    const side = await conforms([
      at(T1, reject(HELD.a1)), at(T2, reject(HELD.a1)), at(T1, approve(HELD.a3)), at(T2, reject(HELD.a3)), ids({ status: 'rejected' }), scopeOf(HELD.a3),
    ]);
    const [, again, , afterApprove, rejected, a3] = values(side);
    expect([again, afterApprove]).toEqual([{ outcome: 'already_decided', status: 'rejected' }, { outcome: 'already_decided', status: 'approved' }]);
    expect([rejected, a3]).toEqual([[HELD.a1], [{ id: HELD.a3, scope: 'team:alpha' }]]);
    expect(added(side).map((e) => [e.op, e.targetId, e.ts])).toEqual([['quarantine_reject', HELD.a1, T1], ['quarantine_approve', HELD.a3, T1]]);
  });
});

describe('on hippo.db, a decision whose audit row is refused', () => {
  let root: string;

  /** The record and the memory row as hippo.db holds them. */
  const stored = () => {
    const db = openHippoDb(root);
    try {
      // SAFETY: each SELECT names exactly the columns of the type it is read as.
      const record = db.prepare('SELECT status, decided_at, decided_by FROM memory_quarantine WHERE tenant_id = ? AND memory_id = ?').get(TENANT_A, HELD.a1) as
        { status: string; decided_at: string | null; decided_by: string | null };
      // SAFETY: as above.
      const memory = db.prepare('SELECT scope FROM memories WHERE id = ?').get(HELD.a1) as { scope: string | null };
      return { record, scope: memory.scope, auditId: auditHighIdAt(db) };
    } finally {
      closeHippoDb(db);
    }
  };

  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), 'hippo-quarantine-atomic-')), 'store');
    cpSync(fixture.dir, root, { recursive: true });
    const db = openHippoDb(root);
    try {
      db.exec(`CREATE TRIGGER audit_broken BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit table unwritable'); END`);
    } finally {
      closeHippoDb(db);
    }
  });

  afterEach(() => {
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('approve rejects and leaves the scope and the record as they were', async () => {
    const before = stored();
    expect(before).toEqual({ record: { status: 'pending', decided_at: null, decided_by: null }, scope: ALPHA_HELD, auditId: nextAuditId - 1 });
    await expect(sqliteStore(root).quarantine.approveQuarantined(TENANT_A, HELD.a1, ACTOR)).rejects.toThrow(/audit table unwritable/);
    expect(stored()).toEqual(before);
  });

  it('reject rejects and leaves the record pending', async () => {
    const before = stored();
    await expect(sqliteStore(root).quarantine.rejectQuarantined(TENANT_A, HELD.a1, ACTOR)).rejects.toThrow(/audit table unwritable/);
    expect(stored()).toEqual(before);
  });
});
