// AuditLog answers alike on hippo.db and on a store held in memory, with no audit row written, and GET /v1/audit built on
// it answers the same over serve() on either store.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAuditEvent, listAuditEventsAfter, type AuditOp, type QueryAuditOpts } from '../src/audit.js';
import { createApiKey } from '../src/auth.js';
import { _resetSharedStoreCacheForTests, markSharedStore } from '../src/config.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { serve, type AuditEvent, type HippoStore, type KeysetPosition } from '../src/server.js';
import { inMemoryAuditLogStore } from './_helpers/in-memory-audit-log-store.js';
import { CLEARED_ENV } from './_helpers/recall-golden-seed.js';
import { onBothStores, seedTwoTenants, TENANT_A, TENANT_B, type GroupCall, type TwoTenantFixture } from './_helpers/store-conformance.js';

const HOST = '__host__';
const at = (second: number): string => `2020-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;

// tenant, op, second, target: ids run from 12 in this order, above the 10 rows seedTwoTenants leaves under ids 1 to 10.
const LOGGED: readonly (readonly [string, AuditOp, number, string])[] = [
  [TENANT_A, 'recall', 1, 'q1'],
  [TENANT_A, 'recall', 2, 'q2'],
  [TENANT_B, 'recall', 2, 'qb'],
  [TENANT_A, 'forget', 3, 'm1'],
  [TENANT_A, 'recall', 3, 'q3'],
  [TENANT_A, 'forget', 4, 'm2'],
  [TENANT_A, 'recall', 5, 'q4'],
  [TENANT_B, 'forget', 5, 'mb'],
  [HOST, 'consolidate', 6, 'sleep'],
  ['solo', 'remember', 6, 's1'],
  [TENANT_A, 'recall', 0, 'q0'],
];
const BULK_ROWS = 105;
const BULK_FIRST_ID = 12 + LOGGED.length;

/** Each tenant's ids newest first: the seed rows carry the wall clock, so they sit above every 2020 row. */
const A_IDS = [9, 7, 5, 4, 3, 1, 18, 17, 16, 15, 13, 12, 22];
const B_IDS = [10, 8, 6, 2, 19, 14];
const BULK_IDS = Array.from({ length: BULK_ROWS }, (_, i) => BULK_FIRST_ID + BULK_ROWS - 1 - i);

type Call<R> = GroupCall<'auditLog', R>;

let fixture: TwoTenantFixture;
let fixtureAudit: readonly AuditEvent[];
let hostAdminToken: string;

/** Runs the calls on both stores, asserts they agree and wrote no audit row, and returns hippo.db's values. */
async function conforms<R>(calls: readonly Call<R>[]): Promise<R[]> {
  const sides = await onBothStores(fixture, 'auditLog', inMemoryAuditLogStore, calls);
  expect(sides.other).toEqual(sides.sqlite);
  expect(sides.sqlite.audit).toEqual(fixtureAudit);
  return sides.sqlite.outcomes.map((o) => {
    if ('error' in o) throw new Error(o.error);
    return o.value;
  });
}

const list = (query: Partial<QueryAuditOpts> = {}): Call<AuditEvent[]> => (g) => g.listAuditEvents({ tenantId: TENANT_A, ...query });
const ids = (rows: readonly AuditEvent[]): number[] => rows.map((row) => row.id);
const below = (second: number, id: number): KeysetPosition => ({ key: at(second), id });

/** Every page of `limit` rows, each resumed from the last row of the one before, until a page comes back empty. */
const pages = (limit: number, tenantId = TENANT_A): Call<AuditEvent[][]> => async (g) => {
  const read: AuditEvent[][] = [];
  let after: KeysetPosition | undefined;
  for (;;) {
    const page = await g.listAuditEvents({ tenantId, limit, after });
    const last = page[page.length - 1];
    if (!last) return read;
    read.push(page);
    after = { key: last.ts, id: last.id };
  }
};

function seedAuditRows(dir: string): void {
  const db = openHippoDb(dir);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    for (const [tenantId, op, second, targetId] of LOGGED) {
      vi.setSystemTime(new Date(at(second)));
      appendAuditEvent(db, { tenantId, actor: 'cli', op, targetId, metadata: { second } });
    }
    vi.setSystemTime(new Date(at(30)));
    for (let i = 0; i < BULK_ROWS; i++) appendAuditEvent(db, { tenantId: 'bulk', actor: 'cli', op: 'outcome', targetId: `b${i}` });
    hostAdminToken = createApiKey(db, { tenantId: 'default', label: 'host-admin', role: 'admin' }).plaintext;
    fixtureAudit = listAuditEventsAfter(db, { afterId: 0, limit: 10_000 });
  } finally {
    vi.useRealTimers();
    closeHippoDb(db);
  }
}

beforeAll(() => {
  fixture = seedTwoTenants();
  seedAuditRows(fixture.dir);
}, 60_000);

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
});

describe('AuditLog.listAuditEvents', () => {
  it('reads nothing for a tenant with no row, and the whole row of a one-row tenant', async () => {
    const [none, one] = await conforms([list({ tenantId: 'nobody' }), list({ tenantId: 'solo' })]);
    expect(none).toEqual([]);
    expect(one).toEqual([{ id: 21, ts: at(6), tenantId: 'solo', actor: 'cli', op: 'remember', targetId: 's1', metadata: { second: 6 } }]);
  });

  it("lists a tenant newest first, by id inside a shared timestamp, and never another tenant's rows", async () => {
    const got = await conforms([list(), list({ tenantId: TENANT_B }), list({ tenantId: HOST })]);
    expect(got.map(ids)).toEqual([A_IDS, B_IDS, [20]]);
  });

  it('keeps the newest rows at, under and over the limit, and one row for a limit below one', async () => {
    const n = A_IDS.length;
    const got = await conforms([list({ limit: n }), list({ limit: n - 1 }), list({ limit: n + 1 }), list({ limit: 1 }), list({ limit: 0 }), list({ limit: -3 })]);
    expect(got.map(ids)).toEqual([A_IDS, A_IDS.slice(0, n - 1), A_IDS, [9], [9], [9]]);
  });

  it('reads 100 rows with no limit given, and every row under a limit above the count', async () => {
    const got = await conforms([list({ tenantId: 'bulk' }), list({ tenantId: 'bulk', limit: BULK_ROWS }), list({ tenantId: 'bulk', limit: 20_000 })]);
    expect(got.map(ids)).toEqual([BULK_IDS.slice(0, 100), BULK_IDS, BULK_IDS]);
  });

  it('narrows by op alone and by since alone, a row at the since bound kept', async () => {
    const seeded = A_IDS.slice(0, 6);
    const got = await conforms([
      list({ op: 'recall' }), list({ op: 'promote' }), list({ since: at(3) }), list({ since: '2020-01-01T00:00:03.001Z' }), list({ since: '2999-01-01T00:00:00.000Z' }),
    ]);
    expect(got.map(ids)).toEqual([[18, 16, 13, 12, 22], [], [...seeded, 18, 17, 16, 15], [...seeded, 18, 17], []]);
  });

  it('resumes below a position alone, between two rows sharing a timestamp and inside the asking tenant', async () => {
    const got = await conforms([
      list({ after: below(3, 16) }), list({ after: below(3, 15) }), list({ after: below(3, 999) }), list({ after: below(0, 22) }),
      list({ tenantId: TENANT_B, after: below(3, 16) }),
    ]);
    expect(got.map(ids)).toEqual([[15, 13, 12, 22], [13, 12, 22], [16, 15, 13, 12, 22], [], [14]]);
  });

  it('applies op, since, limit and a position together', async () => {
    const got = await conforms([
      list({ op: 'recall', since: at(2), limit: 2 }),
      list({ op: 'recall', since: at(2), limit: 2, after: below(3, 16) }),
      list({ op: 'forget', since: at(4), after: below(5, 18) }),
      list({ op: 'forget', since: at(1), limit: 1 }),
    ]);
    expect(got.map(ids)).toEqual([[18, 16], [13], [17], [17]]);
  });

  it('pages a tenant by cursor with no row twice and none missed, a page boundary falling inside a shared timestamp', async () => {
    const got = await conforms([pages(9), pages(4), pages(1), pages(50, 'bulk'), pages(5, 'nobody')]);
    const idPages = got.map((read) => read.map(ids));
    expect(idPages[0]).toEqual([A_IDS.slice(0, 9), [15, 13, 12, 22]]);
    expect(idPages[1]).toEqual([A_IDS.slice(0, 4), A_IDS.slice(4, 8), A_IDS.slice(8, 12), [22]]);
    expect(idPages[2]).toEqual(A_IDS.map((id) => [id]));
    expect(idPages[3]).toEqual([BULK_IDS.slice(0, 50), BULK_IDS.slice(50, 100), BULK_IDS.slice(100)]);
    expect(idPages[4]).toEqual([]);
  });
});

interface Reply { readonly status: number; readonly body: unknown; readonly next: string | null }
type Asker = 'adminA' | 'memberA' | 'host';

const SERVED: readonly (readonly [Asker, string, number])[] = [
  ['adminA', '', 200],
  ['memberA', '?op=recall', 200],
  ['adminA', `?since=${encodeURIComponent(at(3))}&op=forget`, 200],
  ['adminA', '?limit=9', 200],
  ['adminA', '?limit=9&cursor=', 200],
  ['host', `?tenant=${TENANT_A}&limit=4`, 200],
  ['host', `?tenant=${HOST}`, 200],
  ['host', '?tenant=bulk&limit=10000', 200],
  ['adminA', `?tenant=${TENANT_B}`, 403],
  ['memberA', `?tenant=${HOST}`, 403],
  ['adminA', '?limit=0', 400],
];

/** Every SERVED request over serve() on a fresh copy of the fixture; a query ending in `cursor=` takes the cursor the reply before it gave. */
async function runServed(makeStore?: (root: string) => HippoStore): Promise<Reply[]> {
  _resetSharedStoreCacheForTests();
  const home = mkdtempSync(join(tmpdir(), 'hippo-audit-served-'));
  try {
    const root = join(home, 'store');
    cpSync(fixture.dir, root, { recursive: true });
    vi.stubEnv('HIPPO_HOME', join(home, 'global'));
    // serve() marks another store's root shared, so the hippo.db pass is shared too to compare like with like.
    markSharedStore(root);
    const store = makeStore?.(root);
    const handle = await serve({ hippoRoot: root, port: 0, store });
    const tokens = { adminA: fixture.tokens.adminA, memberA: fixture.tokens.memberA, host: hostAdminToken } satisfies Record<Asker, string>;
    const replies: Reply[] = [];
    try {
      for (const [asker, query] of SERVED) {
        const cursor = query.endsWith('cursor=') ? encodeURIComponent(replies[replies.length - 1]?.next ?? '') : '';
        const res = await fetch(`${handle.url}/v1/audit${query}${cursor}`, { headers: { authorization: `Bearer ${tokens[asker]}` } });
        replies.push({ status: res.status, body: await res.json(), next: res.headers.get('x-next-cursor') });
      }
    } finally {
      await handle.stop();
      await store?.close();
    }
    return replies;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('GET /v1/audit over serve()', () => {
  beforeEach(() => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    vi.stubEnv('HIPPO_V1_RPS', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetSharedStoreCacheForTests();
  });

  it('answers the same on hippo.db and on a store held in memory', async () => {
    const onHippoDb = await runServed();
    expect(onHippoDb.map((r) => r.status)).toEqual(SERVED.map(([, , status]) => status));
    // SAFETY: each reply read here answered 200 above, and a 200 from this route is an array of audit rows.
    const idsAt = (i: number): number[] => ids(onHippoDb[i]?.body as AuditEvent[]);
    expect([0, 1, 2, 3, 4, 5, 6].map(idsAt)).toEqual([A_IDS, [18, 16, 13, 12, 22], [17, 15], A_IDS.slice(0, 9), [15, 13, 12, 22], A_IDS.slice(0, 4), [20]]);
    expect(idsAt(7)).toEqual(BULK_IDS);
    expect(onHippoDb.map((r) => r.next !== null)).toEqual([false, false, false, true, false, true, false, false, false, false, false]);
    expect(await runServed((root) => inMemoryAuditLogStore(root).store)).toEqual(onHippoDb);
  }, 120_000);
});
