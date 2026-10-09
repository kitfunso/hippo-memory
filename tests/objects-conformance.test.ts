// Objects answers alike on hippo.db and on a store held in memory: the same rows, the same order, the same refusals and the same audit rows,
// and on hippo.db a write whose audit row fails keeps nothing.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAuditEventsAfter, type AuditEvent, type AuditOp } from '../src/store/audit.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { closeIncident, resolveIncident, saveIncident } from '../src/incidents.js';
import { objectMirror } from '../src/objects/lifecycle.js';
import { requireGroup, sqliteStore } from '../src/store-port.js';
import { auditHighIdAt } from '../src/store/key-audit.js';
import type { ObjectByKind, ObjectFields, ObjectKind, SavableKind } from '../src/store/object-types.js';
import type { ObjectListQuery, ObjectRefusal, ObjectSave } from '../src/store/port.js';
import { inMemoryObjectsStore } from './_helpers/in-memory-objects-store.js';
import { onBothStores, seedTwoTenants, TENANT_A, TENANT_B, type GroupCall, type SideResult, type TwoTenantFixture } from './_helpers/store-conformance.js';

const NOW = '2026-03-01T12:00:00.000Z';
const T1 = '2026-03-01T12:00:01.000Z';
const T2 = '2026-03-01T12:00:02.000Z';
const T3 = '2026-03-01T12:00:03.000Z';
const T4 = '2026-03-01T12:00:04.000Z';
const T5 = '2026-03-01T12:00:05.000Z';
const ACTOR = 'api_key:caller';

type Metadata = AuditEvent['metadata'];

/** One savable kind: the nth save's fields, what its row holds for them, and the create row's keys after the id. `group` fills the filter column. */
interface KindCase {
  readonly kind: SavableKind;
  readonly idKey: string;
  readonly versioned: boolean;
  readonly filtered: boolean;
  readonly fields: (n: number, group: string) => ObjectFields[SavableKind];
  readonly own: (n: number, group: string) => Record<string, string | string[] | null>;
  readonly createKeys: (n: number, version: number, group: string) => Metadata;
  readonly supersedeKeys?: (n: number) => Metadata;
}

const odd = (n: number): boolean => n % 2 === 1;
const refreshKeys = (n: number): Metadata => (odd(n) ? { refreshed: false } : { refreshed: true, receipt_count: n });

const CASES: readonly KindCase[] = [
  {
    kind: 'decision', idKey: 'decision_id', versioned: false, filtered: false,
    fields: (n) => ({ decisionText: `decision ${n}`, context: odd(n) ? `context ${n}` : undefined }),
    own: (n) => ({ decisionText: `decision ${n}`, context: odd(n) ? `context ${n}` : null }),
    createKeys: (n) => ({ has_context: odd(n) }),
  },
  {
    kind: 'process', idKey: 'process_id', versioned: true, filtered: false,
    fields: (n) => ({ processName: `process ${n}`, description: odd(n) ? `how ${n}` : undefined, steps: ['plan', `ship ${n}`] }),
    own: (n) => ({ processName: `process ${n}`, description: odd(n) ? `how ${n}` : null, steps: ['plan', `ship ${n}`] }),
    createKeys: (n, version) => ({ version, step_count: 2, has_description: odd(n) }),
  },
  {
    kind: 'policy', idKey: 'policy_id', versioned: true, filtered: false,
    fields: (n) => ({ policyName: `policy ${n}`, policyText: `rule ${n}`, validFrom: '2026-01-01T00:00:00.000Z', validTo: odd(n) ? null : '2027-01-01T00:00:00.000Z' }),
    own: (n) => ({ policyName: `policy ${n}`, policyText: `rule ${n}`, validFrom: '2026-01-01T00:00:00.000Z', validTo: odd(n) ? null : '2027-01-01T00:00:00.000Z' }),
    createKeys: (n, version) => ({ version, open_ended: odd(n) }),
  },
  {
    kind: 'skill', idKey: 'skill_id', versioned: true, filtered: false,
    fields: (n) => ({ name: `skill ${n}`, instructions: `do ${n}`, trigger: odd(n) ? `when ${n}` : null }),
    own: (n) => ({ skillName: `skill ${n}`, instructions: `do ${n}`, trigger: odd(n) ? `when ${n}` : null }),
    createKeys: (n, version) => ({ version, has_trigger: odd(n) }),
  },
  {
    kind: 'project_brief', idKey: 'brief_id', versioned: true, filtered: true,
    fields: (n, group) => ({ repo: group, summary: `summary ${n}`, receiptCount: odd(n) ? undefined : n }),
    own: (n, group) => ({ repo: group, summary: `summary ${n}` }),
    createKeys: (n, version, group) => ({ repo: group, version, ...refreshKeys(n) }),
    supersedeKeys: refreshKeys,
  },
  {
    kind: 'customer_note', idKey: 'note_id', versioned: true, filtered: true,
    fields: (n, group) => ({ customer: group, note: `note ${n}` }),
    own: (n, group) => ({ customer: group, note: `note ${n}` }),
    createKeys: (_n, version, group) => ({ customer: group, version }),
  },
];

/** The mirror as a caller can tell it apart: its row, tenant and what recall matches on. */
interface MirrorView {
  readonly id: string;
  readonly tenantId: string;
  readonly content: string;
  readonly tags: readonly string[];
}

type AnyObject = ObjectByKind[ObjectKind];
type Value = AnyObject | AnyObject[] | number[] | ObjectRefusal | MirrorView[] | boolean | null;
type Call = GroupCall<'objects', Value>;
type Side = SideResult<Value>;

let fixture: TwoTenantFixture;
let baseline: Side;
let nextAuditId: number;

async function conforms(calls: readonly Call[]): Promise<Side> {
  const sides = await onBothStores(fixture, 'objects', inMemoryObjectsStore, calls);
  expect(sides.other).toEqual(sides.sqlite);
  return sides.sqlite;
}

/** One save, built once per call list so both stores are handed the same mirror id. */
interface Draft {
  readonly n: number;
  readonly group: string;
  readonly tenantId: string;
  readonly save: ObjectSave;
}

interface DraftOpts {
  readonly at?: string;
  readonly group?: string;
  readonly tenantId?: string;
  readonly supersedesId?: number;
  readonly changeSummary?: string;
}

function saving(c: KindCase, n: number, opts: DraftOpts = {}): Draft {
  const { at = T1, group = 'alpha', tenantId = TENANT_A } = opts;
  const mirror = objectMirror(fixture.dir, tenantId, c.kind, { content: `${c.kind} ${n}`, tags: ['conformance'] }, true);
  return { n, group, tenantId, save: { mirror, fields: c.fields(n, group), supersedesId: opts.supersedesId, changeSummary: opts.changeSummary, actor: ACTOR, at } };
}

/** Each write sets the clock inside the call, so both stores stamp its audit rows with the same time. */
const save = (c: KindCase, d: Draft): Call => (g) => {
  vi.setSystemTime(new Date(d.save.at));
  return g.saveObject(d.tenantId, c.kind, d.save);
};
const close = <K extends ObjectKind>(kind: K, id: number, at: string, from: readonly ObjectByKind[K]['status'][], tenantId = TENANT_A): Call => (g) => {
  vi.setSystemTime(new Date(at));
  return g.closeObject(tenantId, kind, id, { from, actor: ACTOR, at });
};
const retire = (c: KindCase, id: number, at: string, tenantId = TENANT_A): Call => close(c.kind, id, at, ['active'], tenantId);
const byId = (kind: ObjectKind, id: number, tenantId = TENANT_A): Call => (g) => g.objectById(tenantId, kind, id);
const list = <K extends ObjectKind>(kind: K, query: ObjectListQuery<K>, tenantId = TENANT_A): Call => (g) => g.listObjects(tenantId, kind, query);
const ids = <K extends ObjectKind>(kind: K, query: ObjectListQuery<K>, tenantId = TENANT_A): Call => async (g) => (await g.listObjects(tenantId, kind, query)).map((o) => o.id);
const mirrorsOf = (drafts: readonly Draft[], tenantId?: string): Call => async (_g, store) =>
  (await store.entriesByIds(drafts.map((d) => d.save.mirror.id), tenantId)).map((e) => ({ id: e.id, tenantId: e.tenantId, content: e.content, tags: e.tags }));

interface RowState {
  readonly version?: number;
  readonly changeSummary?: string;
  readonly status?: 'superseded' | 'closed';
  readonly supersededBy?: number;
  readonly supersededAt?: string;
  readonly closedAt?: string;
}

/** The row a save made, as it reads after the writes `state` names. */
function rowOf(c: KindCase, id: number, d: Draft, state: RowState = {}) {
  const head = { id, memoryId: d.save.mirror.id, tenantId: d.tenantId, ...c.own(d.n, d.group) };
  const tail = {
    status: state.status ?? 'active', supersededBy: state.supersededBy ?? null, supersededAt: state.supersededAt ?? null,
    closedAt: state.closedAt ?? null, createdAt: d.save.at,
  };
  return c.versioned ? { ...head, version: state.version ?? 1, changeSummary: state.changeSummary ?? null, ...tail } : { ...head, ...tail };
}

const mirrorView = (c: KindCase, d: Draft): MirrorView => ({ id: d.save.mirror.id, tenantId: d.tenantId, content: `${c.kind} ${d.n}`, tags: [c.kind, 'conformance'] });

/** The rows a run added, each under the next audit id in turn. */
function added(side: Side): AuditEvent[] {
  return side.audit.slice(baseline.audit.length);
}

function auditRow(nth: number, ts: string, op: AuditOp, targetId: string, metadata: Metadata, tenantId = TENANT_A): AuditEvent {
  return { id: nextAuditId + nth, ts, tenantId, actor: ACTOR, op, targetId, metadata };
}

const createOp = (kind: SavableKind): AuditOp => `${kind}_create`;
const supersedeOp = (kind: SavableKind): AuditOp => `${kind}_supersede`;
const closeOp = (kind: ObjectKind): AuditOp => `${kind}_close`;

const created = (c: KindCase, nth: number, id: number, d: Draft, version = 1): AuditEvent =>
  auditRow(nth, d.save.at, createOp(c.kind), String(id), { [c.idKey]: id, ...c.createKeys(d.n, version, d.group) }, d.tenantId);
const remembered = (nth: number, d: Draft): AuditEvent => auditRow(nth, d.save.at, 'remember', d.save.mirror.id, { kind: 'distilled', scope: null }, d.tenantId);
/** `d` is the successor that replaced row `replaced` and took id `id`. */
function superseded(c: KindCase, nth: number, replaced: number, id: number, d: Draft, version: number): AuditEvent {
  const own: Metadata = { [c.idKey]: replaced, superseded_by: id };
  if (c.versioned) own.new_version = version;
  return auditRow(nth, d.save.at, supersedeOp(c.kind), String(replaced), { ...own, ...c.supersedeKeys?.(d.n) });
}

function auditRowsAt(root: string): AuditEvent[] {
  const db = openHippoDb(root);
  try {
    return listAuditEventsAfter(db, { afterId: 0, limit: 10_000 });
  } finally {
    closeHippoDb(db);
  }
}

/** Incident ids 1 to 6, id 4 in the other tenant: two instants each shared by two of the tenant's rows, then 2 resolved and 1 closed. */
function seedIncidents(dir: string): void {
  const open = (iso: string, text: string, tenantId = TENANT_A): void => {
    vi.setSystemTime(new Date(iso));
    saveIncident(dir, tenantId, { incidentText: text, context: `seen at ${iso}` }, ACTOR);
  };
  open(T1, 'checkout latency');
  open(T1, 'queue backlog');
  open(T2, 'login errors');
  open(T2, 'their outage', TENANT_B);
  open(T2, 'disk pressure');
  open(T3, 'stale cache');
  vi.setSystemTime(new Date(T4));
  resolveIncident(dir, TENANT_A, 2, 'drained the queue', ACTOR);
  closeIncident(dir, TENANT_A, 1, ACTOR);
}

beforeAll(async () => {
  fixture = seedTwoTenants();
  vi.useFakeTimers({ toFake: ['Date'] });
  seedIncidents(fixture.dir);
  vi.useRealTimers();
  const db = openHippoDb(fixture.dir);
  try {
    nextAuditId = auditHighIdAt(db) + 1;
  } finally {
    closeHippoDb(db);
  }
  baseline = await conforms([]);
});

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

describe.each(CASES)('Objects, the $kind kind', (c) => {
  it('lists nothing, then the one row a save made, and reads it only inside its tenant; the create row sits ahead of the remember row', async () => {
    const first = saving(c, 1, { changeSummary: 'a first version keeps none' });
    const side = await conforms([
      list(c.kind, { limit: 10 }), byId(c.kind, 1), save(c, first), list(c.kind, { limit: 10 }), byId(c.kind, 1),
      byId(c.kind, 1, TENANT_B), byId(c.kind, 2), list(c.kind, { limit: 10 }, TENANT_B), mirrorsOf([first], TENANT_A), mirrorsOf([first], TENANT_B),
      (g) => g.mirrorsOnDefaultHalfLife(),
    ]);
    const row = rowOf(c, 1, first);
    expect(side.outcomes).toEqual([
      { value: [] }, { value: null }, { value: row }, { value: [row] }, { value: row },
      { value: null }, { value: null }, { value: [] }, { value: [mirrorView(c, first)] }, { value: [] },
      { value: true },
    ]);
    expect(added(side)).toEqual([created(c, 0, 1, first), remembered(1, first)]);
  });

  it('a successor takes the next version, links the row it replaces and marks it superseded, the supersede row ahead of the create row', async () => {
    const first = saving(c, 1);
    const second = saving(c, 2, { at: T2, supersedesId: 1, changeSummary: 'tightened' });
    const third = saving(c, 3, { at: T3, supersedesId: 2 });
    const side = await conforms([save(c, first), save(c, second), save(c, third), byId(c.kind, 1), byId(c.kind, 2), byId(c.kind, 3), mirrorsOf([first, second, third])]);
    const tightened = c.versioned ? 'tightened' : undefined;
    const rows = [
      rowOf(c, 1, first, { status: 'superseded', supersededBy: 2, supersededAt: T2 }),
      rowOf(c, 2, second, { version: 2, changeSummary: tightened, status: 'superseded', supersededBy: 3, supersededAt: T3 }),
      rowOf(c, 3, third, { version: 3 }),
    ];
    expect(side.outcomes).toEqual([
      { value: rowOf(c, 1, first) }, { value: rowOf(c, 2, second, { version: 2, changeSummary: tightened }) }, { value: rows[2] },
      { value: rows[0] }, { value: rows[1] }, { value: rows[2] },
      { value: [mirrorView(c, first), mirrorView(c, second), mirrorView(c, third)] },
    ]);
    expect(added(side)).toEqual([
      created(c, 0, 1, first), remembered(1, first),
      superseded(c, 2, 1, 2, second, 2), created(c, 3, 2, second, 2), remembered(4, second),
      superseded(c, 5, 2, 3, third, 3), created(c, 6, 3, third, 3), remembered(7, third),
    ]);
  });

  it('a save that replaces a missing, a foreign, a superseded or a closed row is refused and keeps no mirror, no row, no audit row and no id', async () => {
    const first = saving(c, 1);
    const second = saving(c, 2, { at: T2, supersedesId: 1 });
    const third = saving(c, 3, { at: T2 });
    const refused = [
      saving(c, 4, { at: T4, supersedesId: 9 }), saving(c, 5, { at: T4, supersedesId: 2, tenantId: TENANT_B }),
      saving(c, 6, { at: T4, supersedesId: 1 }), saving(c, 7, { at: T4, supersedesId: 3 }),
    ];
    const next = saving(c, 8, { at: T5 });
    const side = await conforms([
      save(c, first), save(c, second), save(c, third), retire(c, 3, T3),
      ...refused.map((d) => save(c, d)),
      mirrorsOf(refused), ids(c.kind, { limit: 10 }), ids(c.kind, { limit: 10 }, TENANT_B), byId(c.kind, 2), save(c, next),
    ]);
    expect(side.outcomes.slice(4)).toEqual([
      { value: { refused: 'missing' } }, { value: { refused: 'missing' } },
      { value: { refused: 'status', status: 'superseded' } }, { value: { refused: 'status', status: 'closed' } },
      { value: [] }, { value: [3, 2, 1] }, { value: [] }, { value: rowOf(c, 2, second, { version: 2 }) }, { value: rowOf(c, 4, next) },
    ]);
    expect(added(side).map((e) => e.op)).toEqual([
      createOp(c.kind), 'remember', supersedeOp(c.kind), createOp(c.kind), 'remember', createOp(c.kind), 'remember', closeOp(c.kind), createOp(c.kind), 'remember',
    ]);
  });

  it('close retires an active row once with one close row; a superseded, a closed, a missing and a foreign row are refused and stay as they were', async () => {
    const first = saving(c, 1);
    const second = saving(c, 2, { at: T2, supersedesId: 1 });
    const third = saving(c, 3, { at: T2 });
    const side = await conforms([
      save(c, first), save(c, second), save(c, third),
      retire(c, 2, T3), retire(c, 2, T4), retire(c, 1, T4), retire(c, 9, T4), retire(c, 3, T4, TENANT_B),
      close(c.kind, 3, T4, []), byId(c.kind, 1), byId(c.kind, 2), byId(c.kind, 3),
    ]);
    const closed = rowOf(c, 2, second, { version: 2, status: 'closed', closedAt: T3 });
    expect(side.outcomes.slice(3)).toEqual([
      { value: closed }, { value: { refused: 'status', status: 'closed' } }, { value: { refused: 'status', status: 'superseded' } },
      { value: { refused: 'missing' } }, { value: { refused: 'missing' } },
      { value: { refused: 'status', status: 'active' } },
      { value: rowOf(c, 1, first, { status: 'superseded', supersededBy: 2, supersededAt: T2 }) }, { value: closed }, { value: rowOf(c, 3, third) },
    ]);
    expect(added(side).slice(7)).toEqual([auditRow(7, T3, closeOp(c.kind), '2', { [c.idKey]: 2 })]);
  });

  /** Ids 1 to 8, id 5 in the other tenant: three instants each shared by two of the tenant's rows, then 1 closed and 2 superseded by 8. Odd ids hold the alpha filter value. */
  const seed = (): Call[] => {
    const row = (n: number, at: string, opts: DraftOpts = {}): Call => save(c, saving(c, n, { at, group: odd(n) ? 'alpha' : 'beta', ...opts }));
    return [
      row(1, T1), row(2, T1), row(3, T2), row(4, T2), row(5, T2, { tenantId: TENANT_B }), row(6, T3), row(7, T3),
      retire(c, 1, T4), row(8, T4, { supersedesId: 2 }),
    ];
  };
  const SEEDED = 9;

  it('lists newest first with the larger id first on a shared instant, under, at and over the cap, by each status and by the filter column', async () => {
    const side = await conforms([
      ...seed(),
      ids(c.kind, { limit: 10 }), ids(c.kind, { limit: 7 }), ids(c.kind, { limit: 3 }), ids(c.kind, { limit: 1 }),
      ids(c.kind, { status: 'active', limit: 10 }), ids(c.kind, { status: 'superseded', limit: 10 }), ids(c.kind, { status: 'closed', limit: 10 }),
      ids(c.kind, { limit: 10 }, TENANT_B), ids(c.kind, { status: 'closed', limit: 10 }, TENANT_B),
      ids(c.kind, { filter: 'alpha', limit: 10 }), ids(c.kind, { filter: 'beta', limit: 10 }), ids(c.kind, { filter: 'alpha', status: 'active', limit: 10 }),
      ids(c.kind, { filter: 'gamma', limit: 10 }), ids(c.kind, { filter: 'alpha', limit: 10 }, TENANT_B),
    ]);
    const every = [8, 7, 6, 4, 3, 2, 1];
    const active = [8, 7, 6, 4, 3];
    // A kind with no filter column ignores the filter.
    const filtered = c.filtered ? [[7, 3, 1], [8, 6, 4, 2], [7, 3], [], [5]] : [every, every, active, every, [5]];
    expect(side.outcomes.slice(SEEDED)).toEqual([
      { value: every }, { value: every }, { value: [8, 7, 6] }, { value: [8] },
      { value: active }, { value: [2] }, { value: [1] },
      { value: [5] }, { value: [] },
      ...filtered.map((value) => ({ value })),
    ]);
  });

  it('pages across a boundary that splits two rows sharing an instant, without a skip or a repeat', async () => {
    const side = await conforms([
      ...seed(),
      ids(c.kind, { limit: 2 }), ids(c.kind, { limit: 2, after: { key: T3, id: 7 } }), ids(c.kind, { limit: 2, after: { key: T2, id: 4 } }),
      ids(c.kind, { limit: 2, after: { key: T1, id: 2 } }), ids(c.kind, { limit: 2, after: { key: T1, id: 1 } }),
      ids(c.kind, { status: 'active', limit: 2, after: { key: T3, id: 7 } }), ids(c.kind, { status: 'active', limit: 2, after: { key: T2, id: 4 } }),
      ids(c.kind, { filter: 'alpha', limit: 1, after: { key: T3, id: 7 } }),
      ids(c.kind, { limit: 10, after: { key: '2026-03-01T12:00:02.500Z', id: 0 } }), ids(c.kind, { limit: 10, after: { key: T3, id: 7 } }, TENANT_B),
    ]);
    expect(side.outcomes.slice(SEEDED)).toEqual([
      { value: [8, 7] }, { value: [6, 4] }, { value: [3, 2] }, { value: [1] }, { value: [] },
      { value: [6, 4] }, { value: [3] },
      { value: c.filtered ? [3] : [6] },
      { value: [4, 3, 2, 1] }, { value: [5] },
    ]);
  });
});

describe('Objects, the incident kind', () => {
  const CLOSABLE = ['open', 'resolved'] as const;

  it('reads the rows by status, newest first and under, at and over the cap, inside the tenant, and ignores a filter', async () => {
    const side = await conforms([
      ids('incident', { limit: 10 }), ids('incident', { limit: 5 }), ids('incident', { limit: 2 }),
      ids('incident', { status: 'open', limit: 10 }), ids('incident', { status: 'resolved', limit: 10 }), ids('incident', { status: 'closed', limit: 10 }),
      ids('incident', { limit: 10 }, TENANT_B), ids('incident', { filter: 'alpha', limit: 10 }),
      ids('incident', { limit: 2, after: { key: T2, id: 5 } }), ids('incident', { limit: 2, after: { key: T1, id: 2 } }), ids('incident', { limit: 2, after: { key: T1, id: 1 } }),
      byId('incident', 2), byId('incident', 4), byId('incident', 4, TENANT_B), byId('incident', 9),
    ]);
    expect(side.outcomes.slice(0, 11)).toEqual([
      { value: [6, 5, 3, 2, 1] }, { value: [6, 5, 3, 2, 1] }, { value: [6, 5] },
      { value: [6, 5, 3] }, { value: [2] }, { value: [1] },
      { value: [4] }, { value: [6, 5, 3, 2, 1] },
      { value: [3, 2] }, { value: [1] }, { value: [] },
    ]);
    expect(side.outcomes.slice(11)).toMatchObject([
      { value: { id: 2, tenantId: TENANT_A, incidentText: 'queue backlog', status: 'resolved', resolutionText: 'drained the queue', resolvedAt: T4, linkedMemoryIds: [], createdAt: T1 } },
      { value: null },
      { value: { id: 4, tenantId: TENANT_B, incidentText: 'their outage', status: 'open', resolutionText: null, closedAt: null, createdAt: T2 } },
      { value: null },
    ]);
    expect(added(side)).toEqual([]);
  });

  it('close retires an open and a resolved row with one close row each; a closed, a missing and a foreign row are refused and stay as they were', async () => {
    const side = await conforms([
      close('incident', 3, T5, CLOSABLE), close('incident', 2, T5, CLOSABLE), close('incident', 1, T5, CLOSABLE), close('incident', 3, T5, CLOSABLE),
      close('incident', 9, T5, CLOSABLE), close('incident', 4, T5, CLOSABLE), close('incident', 5, T5, ['resolved']),
      byId('incident', 4, TENANT_B), byId('incident', 5), ids('incident', { status: 'closed', limit: 10 }),
    ]);
    expect(side.outcomes).toMatchObject([
      { value: { id: 3, status: 'closed', closedAt: T5, resolutionText: null } },
      { value: { id: 2, status: 'closed', closedAt: T5, resolutionText: 'drained the queue', resolvedAt: T4 } },
      { value: { refused: 'status', status: 'closed' } }, { value: { refused: 'status', status: 'closed' } },
      { value: { refused: 'missing' } }, { value: { refused: 'missing' } }, { value: { refused: 'status', status: 'open' } },
      { value: { id: 4, status: 'open', closedAt: null } }, { value: { id: 5, status: 'open', closedAt: null } }, { value: [3, 2, 1] },
    ]);
    expect(added(side)).toEqual([
      auditRow(0, T5, 'incident_close', '3', { incident_id: 3 }),
      auditRow(1, T5, 'incident_close', '2', { incident_id: 2 }),
    ]);
  });
});

describe("hippo.db's Objects writes are one transaction each", () => {
  /** A constraint the audit log really enforces, so the append fails after the rows of the same write are in. */
  function refuseAuditOps(root: string, ops: readonly AuditOp[]): void {
    const db = openHippoDb(root);
    try {
      const named = ops.map((op) => `'${op}'`).join(', ');
      db.exec(`CREATE TRIGGER audit_op_refused BEFORE INSERT ON audit_log WHEN NEW.op IN (${named}) BEGIN SELECT RAISE(ABORT, 'audit row refused'); END`);
    } finally {
      closeHippoDb(db);
    }
  }

  it.each(CASES)('a $kind save or close whose audit row is refused keeps no row, no mirror, no successor link, no closed status and no audit row', async (c) => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-objects-atomic-'));
    try {
      cpSync(fixture.dir, root, { recursive: true });
      const store = sqliteStore(root);
      const objects = requireGroup(store, 'objects');
      const first = saving(c, 1);
      await objects.saveObject(TENANT_A, c.kind, first.save);
      refuseAuditOps(root, [createOp(c.kind), closeOp(c.kind)]);
      const fresh = saving(c, 2, { at: T2 });
      const successor = saving(c, 3, { at: T2, supersedesId: 1 });
      const before = auditRowsAt(root);

      await expect(objects.saveObject(TENANT_A, c.kind, fresh.save)).rejects.toThrow('audit row refused');
      await expect(objects.saveObject(TENANT_A, c.kind, successor.save)).rejects.toThrow('audit row refused');
      await expect(objects.closeObject(TENANT_A, c.kind, 1, { from: ['active'], actor: ACTOR, at: T3 })).rejects.toThrow('audit row refused');

      expect(await objects.listObjects(TENANT_A, c.kind, { limit: 10 })).toEqual([rowOf(c, 1, first)]);
      expect(await store.entriesByIds([first.save.mirror.id, fresh.save.mirror.id, successor.save.mirror.id], TENANT_A)).toMatchObject([{ id: first.save.mirror.id }]);
      expect(auditRowsAt(root)).toEqual(before);
      await store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
