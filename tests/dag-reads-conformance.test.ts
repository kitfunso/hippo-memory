// DagReads answers alike on hippo.db and on a store held in memory, with no audit row written, and the assemble and drill
// routes built on it answer the same over serve() on either store.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAuditEventsAfter } from '../src/audit.js';
import { _resetSharedStoreCacheForTests, markSharedStore } from '../src/config.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { passesScopeFilterForRecall, serve, type AuditEvent, type HippoStore, type MemoryEntry } from '../src/server.js';
import { writeEntry } from '../src/store/entry-writes.js';
import type { SessionRawCount, SessionRawWindow, SummaryDescendants } from '../src/store/port.js';
import { inMemoryDagReadsStore } from './_helpers/in-memory-dag-reads-store.js';
import { CLEARED_ENV, seeded } from './_helpers/recall-golden-seed.js';
import { onBothStores, seedTwoTenants, TENANT_A, TENANT_B, type GroupCall, type TwoTenantFixture } from './_helpers/store-conformance.js';

const SESSION = 'sess-dag';
const PRIVATE = 'slack:private:C1';
const OWN = 'personal:private:alice';

const at = (minute: number): string => `2026-03-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

function row(tenantId: string, id: string, minute: number, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return seeded(`${id} holds a note about the rollout`, id, at(minute), { tenantId, origin_project: 'proj', ...extra });
}

const raw = (tenantId: string, id: string, minute: number, extra: Partial<MemoryEntry> = {}): MemoryEntry =>
  row(tenantId, id, minute, { kind: 'raw', source_session_id: SESSION, ...extra });

const under = (parent: string, level: number, extra: Partial<MemoryEntry> = {}): Partial<MemoryEntry> => ({ dag_parent_id: parent, dag_level: level, ...extra });

/** One session in both tenants with every scope, origin and supersede edge, and summary trees three levels deep, one of them a loop. */
function dagRows(): MemoryEntry[] {
  return [
    ...[0, 1, 2].map((i) => raw(TENANT_A, `raw_a_${i}`, i, { dag_parent_id: 'sum_a' })),
    ...[3, 4, 5].map((i) => raw(TENANT_A, `raw_a_${i}`, i)),
    raw(TENANT_A, 'raw_a_tie_x', 6),
    raw(TENANT_A, 'raw_a_tie_y', 6),
    raw(TENANT_A, 'raw_a_private', 7, { scope: PRIVATE }),
    raw(TENANT_A, 'raw_a_alice', 8, { scope: OWN }),
    raw(TENANT_A, 'raw_a_legacy', 9, { scope: 'unknown:legacy' }),
    raw(TENANT_A, 'raw_a_team', 10, { scope: 'team:eng' }),
    raw(TENANT_A, 'raw_a_other', 11, { origin_project: 'other' }),
    raw(TENANT_A, 'raw_a_global', 12, { origin_project: '' }),
    raw(TENANT_A, 'raw_a_no_origin', 13, { origin_project: null }),
    raw(TENANT_A, 'raw_a_superseded', 14, { superseded_by: 'raw_a_5' }),
    row(TENANT_A, 'note_a_distilled', 15, { source_session_id: SESSION }),
    raw(TENANT_A, 'raw_a_solo', 16, { source_session_id: 'sess-one' }),
    raw(TENANT_B, 'raw_b_0', 3),
    raw(TENANT_B, 'raw_b_1', 4),
    row(TENANT_A, 'profile_a', 30, { dag_level: 3 }),
    row(TENANT_A, 'sum_a2', 19, under('profile_a', 2)),
    row(TENANT_A, 'sum_a', 20, under('profile_a', 2)),
    row(TENANT_A, 'sum_a_empty', 31, { dag_level: 2 }),
    row(TENANT_A, 'fact_a2_0', 21, under('sum_a2', 1)),
    row(TENANT_A, 'fact_a_0', 21, under('sum_a', 1)),
    row(TENANT_A, 'fact_a_1', 22, under('sum_a', 1)),
    row(TENANT_A, 'fact_a_tie_y', 23, under('sum_a', 1)),
    row(TENANT_A, 'fact_a_tie_x', 23, under('sum_a', 1)),
    row(TENANT_A, 'fact_a_private', 24, under('sum_a', 1, { scope: PRIVATE })),
    row(TENANT_B, 'fact_b_stray', 25, under('sum_a', 1)),
    row(TENANT_A, 'leaf_a_0', 26, under('fact_a_0', 0)),
    row(TENANT_A, 'leaf_a_1', 27, under('fact_a_0', 0)),
    row(TENANT_A, 'leaf_a_under_private', 28, under('fact_a_private', 0)),
    row(TENANT_A, 'loop_a', 40, under('loop_b', 2)),
    row(TENANT_A, 'loop_b', 41, under('loop_a', 2)),
    row(TENANT_B, 'sum_b', 20, { dag_level: 2 }),
    row(TENANT_B, 'fact_b_0', 21, under('sum_b', 1)),
  ];
}

/** The first tenant's live raw rows of SESSION, oldest first. */
const SESSION_IDS = [
  'raw_a_0', 'raw_a_1', 'raw_a_2', 'raw_a_3', 'raw_a_4', 'raw_a_5', 'raw_a_tie_x', 'raw_a_tie_y', 'raw_a_private', 'raw_a_alice',
  'raw_a_legacy', 'raw_a_team', 'raw_a_other', 'raw_a_global', 'raw_a_no_origin',
];
const SUM_A_CHILDREN = ['raw_a_0', 'raw_a_1', 'raw_a_2', 'fact_a_0', 'fact_a_1', 'fact_a_tie_x', 'fact_a_tie_y', 'fact_a_private'];

type Call<R> = GroupCall<'dagReads', R>;

let fixture: TwoTenantFixture;
let fixtureAudit: readonly AuditEvent[];

/** Runs the calls on both stores, asserts they agree and wrote no audit row, and returns hippo.db's values. */
async function conforms<R>(calls: readonly Call<R>[]): Promise<R[]> {
  const sides = await onBothStores(fixture, 'dagReads', inMemoryDagReadsStore, calls);
  expect(sides.other).toEqual(sides.sqlite);
  expect(sides.sqlite.audit).toEqual(fixtureAudit);
  return sides.sqlite.outcomes.map((o) => {
    if ('error' in o) throw new Error(o.error);
    return o.value;
  });
}

const window = (cap: number, over: Partial<SessionRawWindow> = {}): Call<string[]> => async (g) =>
  (await g.sessionRawEntries({ tenantId: TENANT_A, sessionId: SESSION, cap, ...over })).map((r) => r.id);
const count = (over: Partial<SessionRawCount> = {}): Call<number> => (g) => g.sessionRawCount({ tenantId: TENANT_A, sessionId: SESSION, ...over });
const everyRow = (): boolean => true;
const walk = (id: string, depth: number, admit: (r: MemoryEntry) => boolean = everyRow, tenantId = TENANT_A): Call<SummaryDescendants | null> => (g) =>
  g.summaryWithDescendants(tenantId, id, { depth, admit });
const levelIds = (walked: SummaryDescendants | null): string[][] | null => walked && walked.levels.map((level) => level.map((r) => r.id));

beforeAll(() => {
  fixture = seedTwoTenants();
  for (const entry of dagRows()) writeEntry(fixture.dir, entry);
  const db = openHippoDb(fixture.dir);
  try {
    fixtureAudit = listAuditEventsAfter(db, { afterId: 0, limit: 10_000 });
  } finally {
    closeHippoDb(db);
  }
}, 60_000);

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
});

describe('DagReads.sessionRawEntries', () => {
  it('reads nothing for an empty session id, an unknown session and an unknown tenant', async () => {
    expect(await conforms([window(5, { sessionId: '' }), window(5, { sessionId: 'sess-none' }), window(5, { tenantId: 'nobody' })])).toEqual([[], [], []]);
  });

  it('reads a one-row session, and a whole session oldest first with a shared timestamp ordered by id', async () => {
    expect(await conforms([window(5, { sessionId: 'sess-one' }), window(100)])).toEqual([['raw_a_solo'], SESSION_IDS]);
  });

  it('keeps the newest rows at, under and over the cap, and reads them all for a cap of zero or less', async () => {
    const n = SESSION_IDS.length;
    const got = await conforms([window(n), window(n - 1), window(n + 1), window(1), window(0), window(-1)]);
    expect(got).toEqual([SESSION_IDS, SESSION_IDS.slice(1), SESSION_IDS, ['raw_a_no_origin'], SESSION_IDS, SESSION_IDS]);
  });

  it('keeps the larger id of two rows sharing a timestamp when the cap falls between them', async () => {
    const [kept] = await conforms([window(8)]);
    expect(kept).toEqual(SESSION_IDS.slice(-8));
    expect(kept[0]).toBe('raw_a_tie_y');
  });

  it('keeps the named projects beside rows of no project, and drops a row with no recorded origin', async () => {
    const got = await conforms([window(100, { origins: ['proj'] }), window(100, { origins: ['other', 'elsewhere'] }), window(100, { origins: [] })]);
    expect(got).toEqual([
      SESSION_IDS.filter((id) => id !== 'raw_a_other' && id !== 'raw_a_no_origin'),
      ['raw_a_other', 'raw_a_global'],
      ['raw_a_global'],
    ]);
  });

  it("reads only the asking tenant's rows of a session id two tenants share", async () => {
    expect(await conforms([window(100, { tenantId: TENANT_B }), window(1, { tenantId: TENANT_B })])).toEqual([['raw_b_0', 'raw_b_1'], ['raw_b_1']]);
  });
});

describe('DagReads.sessionRawCount', () => {
  it('counts zero for an empty session id, an unknown session and an unknown tenant, and one for a one-row session', async () => {
    const got = await conforms([count({ sessionId: '' }), count({ sessionId: 'sess-none' }), count({ tenantId: 'nobody' }), count({ sessionId: 'sess-one' })]);
    expect(got).toEqual([0, 0, 0, 1]);
  });

  it('leaves private and legacy rows out of the count unless the scope is the caller\'s own or asked for by name', async () => {
    const denied = ['raw_a_private', 'raw_a_alice', 'raw_a_legacy'];
    const got = await conforms([count(), count({ scope: '' }), count({ ownScope: OWN }), count({ scope: PRIVATE }), count({ scope: 'team:eng' }), count({ scope: 'team:none' })]);
    const open = SESSION_IDS.length - denied.length;
    expect(got).toEqual([open, open, open + 1, 1, 1, 0]);
  });

  it('counts inside the named projects and inside the asking tenant', async () => {
    const got = await conforms([count({ origins: ['proj'] }), count({ origins: [], scope: PRIVATE }), count({ origins: [] }), count({ tenantId: TENANT_B })]);
    expect(got).toEqual([SESSION_IDS.length - 5, 0, 1, 2]);
  });
});

describe('DagReads.summaryWithDescendants', () => {
  it("answers null for a missing id and for another tenant's summary", async () => {
    expect(await conforms([walk('sum_missing', 1), walk('sum_b', 1), walk('sum_a', 1, everyRow, TENANT_B)])).toEqual([null, null, null]);
  });

  it("lists one level by created then id, without another tenant's row linked under the summary", async () => {
    const [mine, theirs] = await conforms([walk('sum_a', 1), walk('sum_b', 1, everyRow, TENANT_B)]);
    expect(mine?.summary.id).toBe('sum_a');
    expect(levelIds(mine)).toEqual([SUM_A_CHILDREN]);
    expect(levelIds(theirs)).toEqual([['fact_b_0']]);
  });

  it('reads no level at depth zero, each level down to the depth asked, and stops where the rows end', async () => {
    const leaves = ['leaf_a_0', 'leaf_a_1', 'leaf_a_under_private'];
    const got = (await conforms([walk('sum_a', 0), walk('sum_a', 2), walk('sum_a', 10), walk('profile_a', 3), walk('sum_a_empty', 3), walk('fact_a_0', 1)])).map(levelIds);
    expect(got).toEqual([
      [],
      [SUM_A_CHILDREN, leaves],
      [SUM_A_CHILDREN, leaves],
      [['sum_a2', 'sum_a'], ['fact_a2_0', ...SUM_A_CHILDREN], leaves],
      [],
      [['leaf_a_0', 'leaf_a_1']],
    ]);
  });

  it('leaves out a refused row and reads nothing under it, the summary included', async () => {
    const open = (r: MemoryEntry): boolean => passesScopeFilterForRecall(r.scope ?? null, undefined);
    const got = await conforms([walk('sum_a', 3, open), walk('sum_a', 3, (r) => r.id !== 'sum_a'), walk('profile_a', 3, (r) => r.id !== 'sum_a')]);
    expect(got.map(levelIds)).toEqual([
      [SUM_A_CHILDREN.filter((id) => id !== 'fact_a_private'), ['leaf_a_0', 'leaf_a_1']],
      [],
      [['sum_a2'], ['fact_a2_0']],
    ]);
    expect(got[1]?.summary.id).toBe('sum_a');
  });

  it('lists a row once when two summaries name each other as parent', async () => {
    expect((await conforms([walk('loop_a', 10)])).map(levelIds)).toEqual([[['loop_b']]]);
  });
});

interface Reply { readonly status: number; readonly body: unknown }

const SERVED: readonly (readonly [string, number])[] = [
  [`/v1/sessions/${SESSION}/assemble?freshTail=3&budget=100000`, 200],
  [`/v1/sessions/${SESSION}/assemble?freshTail=3&budget=100000&scope=${encodeURIComponent(PRIVATE)}`, 200],
  [`/v1/sessions/${SESSION}/assemble?summarizeOlder=false&budget=60`, 200],
  ['/v1/sessions/sess-none/assemble', 200],
  ['/v1/recall/drill/sum_a', 200],
  ['/v1/recall/drill/profile_a?depth=3&limit=4', 200],
  ['/v1/recall/drill/fact_a_0', 422],
  ['/v1/recall/drill/sum_b', 404],
  ['/v1/recall/drill/profile_a?limit=1', 200],
  ['/v1/recall/drill/sum_a?limit=3', 200],
  ['/v1/recall/drill/profile_a?depth=2&limit=5', 200],
  ['/v1/recall/drill/profile_a?depth=3&limit=11&budget=100000', 200],
  ['/v1/recall/drill/loop_a?depth=2&limit=1', 200],
];

/** Every SERVED path over serve() on a fresh copy of the fixture, as the first tenant's admin. */
async function runServed(makeStore?: (root: string) => HippoStore): Promise<Reply[]> {
  _resetSharedStoreCacheForTests();
  const home = mkdtempSync(join(tmpdir(), 'hippo-dag-served-'));
  try {
    const root = join(home, 'store');
    cpSync(fixture.dir, root, { recursive: true });
    vi.stubEnv('HIPPO_HOME', join(home, 'global'));
    // serve() marks another store's root shared, so the hippo.db pass is shared too to compare like with like.
    markSharedStore(root);
    const store = makeStore?.(root);
    const handle = await serve({ hippoRoot: root, port: 0, store });
    const replies: Reply[] = [];
    try {
      for (const [path] of SERVED) {
        const res = await fetch(`${handle.url}${path}`, { headers: { authorization: `Bearer ${fixture.tokens.adminA}` } });
        replies.push({ status: res.status, body: await res.json() });
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

describe('assemble and drill over serve()', () => {
  beforeEach(() => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    vi.stubEnv('HIPPO_V1_RPS', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetSharedStoreCacheForTests();
  });

  it('answer the same on hippo.db and on a store held in memory', async () => {
    const onHippoDb = await runServed();
    expect(onHippoDb.map((r) => r.status)).toEqual(SERVED.map(([, status]) => status));
    expect(onHippoDb[0]?.body).toMatchObject({ summarized: 3, items: expect.arrayContaining([expect.objectContaining({ id: 'sum_a', isSummary: true })]) });
    expect(onHippoDb[5]?.body).toMatchObject({ totalChildren: 12, truncated: true });
    expect(onHippoDb.slice(8).map((r) => r.body)).toMatchObject([
      { totalChildren: 2, truncated: true, children: [{ id: 'sum_a2' }] },
      { totalChildren: 7, truncated: true, children: [{ id: 'raw_a_0' }, { id: 'raw_a_1' }, { id: 'raw_a_2' }] },
      { totalChildren: 10, truncated: true, children: [{ id: 'sum_a2' }, { id: 'sum_a' }, { id: 'fact_a2_0' }, { id: 'raw_a_0' }, { id: 'raw_a_1' }] },
      { totalChildren: 12, truncated: true },
      { totalChildren: 1, truncated: false, children: [{ id: 'loop_b' }] },
    ]);
    expect(await runServed((root) => inMemoryDagReadsStore(root).store)).toEqual(onHippoDb);
  }, 120_000);
});
