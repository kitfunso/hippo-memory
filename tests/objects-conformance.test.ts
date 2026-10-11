// Objects answers alike on hippo.db and on a store held in memory: the same rows, the same order, the same refusals and the same audit rows,
// and on hippo.db a write whose audit row fails keeps nothing.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAuditEventsAfter, type AuditEvent, type AuditOp } from '../src/store/audit.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import type { MemoryEntry } from '../src/core/memory.js';
import { objectMirror } from '../src/objects/lifecycle.js';
import { requireGroup, sqliteStore } from '../src/store/index.js';
import { auditHighIdAt } from '../src/store/key-audit.js';
import type { BriefReceipt, Incident, ObjectByKind, ObjectFields, ObjectKind, SavableKind } from '../src/core/object-types.js';
import type { IncidentOpen, IncidentOpenRefusal, ObjectListQuery, ObjectRefusal, ObjectSave } from '../src/store/port.js';
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
type Value = AnyObject | AnyObject[] | number[] | ObjectRefusal | IncidentOpenRefusal | MirrorView[] | BriefReceipt[] | string[] | null;
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
  const mirror = objectMirror(fixture.dir, tenantId, c.kind, { content: `${c.kind} ${n}`, tags: ['conformance'] });
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
const mirrorViews = (mirrorIds: readonly string[], tenantId?: string): Call => async (_g, store) =>
  (await store.entriesByIds(mirrorIds, tenantId)).map((e) => ({ id: e.id, tenantId: e.tenantId, content: e.content, tags: e.tags }));
const mirrorsOf = (drafts: readonly Draft[], tenantId?: string): Call => mirrorViews(drafts.map((d) => d.save.mirror.id), tenantId);

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

beforeAll(async () => {
  fixture = seedTwoTenants();
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
    ]);
    const row = rowOf(c, 1, first);
    expect(side.outcomes).toEqual([
      { value: [] }, { value: null }, { value: row }, { value: [row] }, { value: row },
      { value: null }, { value: null }, { value: [] }, { value: [mirrorView(c, first)] }, { value: [] },
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

/** One incident to open, built once per call list so both stores are handed the same mirror id. */
interface Opening {
  readonly n: number;
  readonly tenantId: string;
  readonly open: IncidentOpen;
}

interface OpeningOpts {
  readonly at?: string;
  readonly tenantId?: string;
  readonly context?: string;
  readonly links?: readonly string[];
}

function opening(n: number, opts: OpeningOpts = {}): Opening {
  const { at = T1, tenantId = TENANT_A } = opts;
  const mirror = objectMirror(fixture.dir, tenantId, 'incident', { content: `incident ${n}`, tags: ['conformance'] });
  return { n, tenantId, open: { mirror, fields: { incidentText: `incident ${n}`, context: opts.context, linkedMemoryIds: opts.links ?? [] }, actor: ACTOR, at } };
}

const linkedTo = (o: Opening, links: readonly string[]): Opening => ({ ...o, open: { ...o.open, fields: { ...o.open.fields, linkedMemoryIds: links } } });
const mirrorIdOf = (o: Opening): string => o.open.mirror.id;

const openIncident = (o: Opening): Call => (g) => {
  vi.setSystemTime(new Date(o.open.at));
  return g.openIncident(o.tenantId, o.open);
};
const resolve = (id: number, at: string, text: string, tenantId = TENANT_A): Call => (g) => {
  vi.setSystemTime(new Date(at));
  return g.resolveIncident(tenantId, id, { text, actor: ACTOR, at });
};

/** The row an open made, as it reads after the writes `state` names. */
function incidentOf(id: number, o: Opening, state: Partial<Incident> = {}): Incident {
  const { incidentText, context, linkedMemoryIds } = o.open.fields;
  return {
    id, memoryId: mirrorIdOf(o), tenantId: o.tenantId, incidentText, context: context ?? null, status: 'open',
    resolutionText: null, resolvedAt: null, closedAt: null, linkedMemoryIds: [...linkedMemoryIds], createdAt: o.open.at, ...state,
  };
}

const incidentMirror = (o: Opening): MirrorView => ({ id: mirrorIdOf(o), tenantId: o.tenantId, content: `incident ${o.n}`, tags: ['incident', 'conformance'] });

/** The two rows one open appends, the open row first. */
function opened(nth: number, id: number, o: Opening): AuditEvent[] {
  const { context, linkedMemoryIds } = o.open.fields;
  const metadata = { incident_id: id, has_context: context !== undefined && context !== '', linked_memory_count: linkedMemoryIds.length };
  return [
    auditRow(nth, o.open.at, 'incident_open', String(id), metadata, o.tenantId),
    auditRow(nth + 1, o.open.at, 'remember', mirrorIdOf(o), { kind: 'distilled', scope: null }, o.tenantId),
  ];
}

const CLOSABLE = ['open', 'resolved'] as const;
const DRAINED = { status: 'resolved', resolutionText: 'drained the queue', resolvedAt: T4 } as const;

/** Incident ids 1 to 6, id 4 in the other tenant: two instants each shared by two of the tenant's rows, then 2 resolved and 1 closed. */
function seededIncidents() {
  const openings = [
    opening(1, { context: 'eu-west' }), opening(2), opening(3, { at: T2 }), opening(4, { at: T2, tenantId: TENANT_B }), opening(5, { at: T2 }), opening(6, { at: T3 }),
  ];
  return { openings, calls: [...openings.map(openIncident), resolve(2, T4, 'drained the queue'), close('incident', 1, T4, CLOSABLE)] };
}
const SEED_CALLS = 8;
const SEED_AUDIT_ROWS = 14;

describe('Objects, the incident kind', () => {
  it('opens each row under the next id with its mirror, the open row ahead of the remember row, and reads it only inside its tenant', async () => {
    const { openings, calls } = seededIncidents();
    const side = await conforms([
      list('incident', { limit: 10 }), ...calls,
      byId('incident', 2), byId('incident', 4), byId('incident', 4, TENANT_B), byId('incident', 9),
      mirrorViews(openings.map(mirrorIdOf), TENANT_A), mirrorViews(openings.map(mirrorIdOf), TENANT_B),
    ]);
    const [o1, o2, o3, o4, o5, o6] = openings;
    expect(side.outcomes).toEqual([
      { value: [] },
      { value: incidentOf(1, o1) }, { value: incidentOf(2, o2) }, { value: incidentOf(3, o3) }, { value: incidentOf(4, o4) }, { value: incidentOf(5, o5) }, { value: incidentOf(6, o6) },
      { value: incidentOf(2, o2, DRAINED) }, { value: incidentOf(1, o1, { status: 'closed', closedAt: T4 }) },
      { value: incidentOf(2, o2, DRAINED) }, { value: null }, { value: incidentOf(4, o4) }, { value: null },
      { value: [o1, o2, o3, o5, o6].map(incidentMirror) }, { value: [incidentMirror(o4)] },
    ]);
    expect(added(side)).toEqual([
      ...opened(0, 1, o1), ...opened(2, 2, o2), ...opened(4, 3, o3), ...opened(6, 4, o4), ...opened(8, 5, o5), ...opened(10, 6, o6),
      auditRow(12, T4, 'incident_resolve', '2', { incident_id: 2 }), auditRow(13, T4, 'incident_close', '1', { incident_id: 1 }),
    ]);
    expect(added(side)[0].metadata).toEqual({ incident_id: 1, has_context: true, linked_memory_count: 0 });
  });

  it('reads the rows by status, newest first and under, at and over the cap, inside the tenant, and ignores a filter', async () => {
    const side = await conforms([
      ...seededIncidents().calls,
      ids('incident', { limit: 10 }), ids('incident', { limit: 5 }), ids('incident', { limit: 2 }),
      ids('incident', { status: 'open', limit: 10 }), ids('incident', { status: 'resolved', limit: 10 }), ids('incident', { status: 'closed', limit: 10 }),
      ids('incident', { limit: 10 }, TENANT_B), ids('incident', { filter: 'alpha', limit: 10 }),
      ids('incident', { limit: 2, after: { key: T2, id: 5 } }), ids('incident', { limit: 2, after: { key: T1, id: 2 } }), ids('incident', { limit: 2, after: { key: T1, id: 1 } }),
    ]);
    expect(side.outcomes.slice(SEED_CALLS)).toEqual([
      { value: [6, 5, 3, 2, 1] }, { value: [6, 5, 3, 2, 1] }, { value: [6, 5] },
      { value: [6, 5, 3] }, { value: [2] }, { value: [1] },
      { value: [4] }, { value: [6, 5, 3, 2, 1] },
      { value: [3, 2] }, { value: [1] }, { value: [] },
    ]);
    expect(added(side)).toHaveLength(SEED_AUDIT_ROWS);
  });

  it('holds the linked ids as given: memories of the tenant, one cited twice, and the mirror the same open writes; an empty context counts as none', async () => {
    const { openings, calls } = seededIncidents();
    const bare = opening(7, { at: T5, context: '' });
    const cited = opening(8, { at: T5, context: 'after 1', links: [mirrorIdOf(openings[0]), mirrorIdOf(bare), mirrorIdOf(openings[0])] });
    const own = opening(9, { at: T5 });
    const selfCited = linkedTo(own, [mirrorIdOf(own)]);
    const theirs = opening(10, { at: T5, tenantId: TENANT_B, links: [mirrorIdOf(openings[3])] });
    const side = await conforms([
      ...calls, openIncident(bare), openIncident(cited), openIncident(selfCited), openIncident(theirs),
      byId('incident', 8), byId('incident', 10), byId('incident', 10, TENANT_B), mirrorViews([bare, cited, selfCited, theirs].map(mirrorIdOf)),
    ]);
    expect(side.outcomes.slice(SEED_CALLS)).toEqual([
      { value: incidentOf(7, bare) }, { value: incidentOf(8, cited) }, { value: incidentOf(9, selfCited) }, { value: incidentOf(10, theirs) },
      { value: incidentOf(8, cited) }, { value: null }, { value: incidentOf(10, theirs) },
      { value: [theirs, bare, cited, selfCited].map(incidentMirror) },
    ]);
    expect(added(side).slice(SEED_AUDIT_ROWS)).toEqual([...opened(14, 7, bare), ...opened(16, 8, cited), ...opened(18, 9, selfCited), ...opened(20, 10, theirs)]);
    expect(added(side)[14].metadata).toEqual({ incident_id: 7, has_context: false, linked_memory_count: 0 });
    expect(added(side)[16].metadata).toEqual({ incident_id: 8, has_context: true, linked_memory_count: 3 });
  });

  it('refuses an open that links an id that is no memory of the tenant, naming the first one in the order given, and keeps no mirror, row, audit row or id', async () => {
    const { openings, calls } = seededIncidents();
    const [ours, , , foreign] = openings.map(mirrorIdOf);
    const refused = [
      opening(7, { at: T5, links: ['mem_never_written'] }), opening(8, { at: T5, links: [ours, foreign] }),
      opening(9, { at: T5, links: ['mem_gone_b', foreign, 'mem_gone_a'] }), opening(10, { at: T5, tenantId: TENANT_B, links: [foreign, ours] }),
    ];
    const next = opening(11, { at: T5, links: [ours] });
    const side = await conforms([
      ...calls, ...refused.map(openIncident),
      mirrorViews(refused.map(mirrorIdOf)), ids('incident', { limit: 10 }), ids('incident', { limit: 10 }, TENANT_B), openIncident(next),
    ]);
    expect(side.outcomes.slice(SEED_CALLS)).toEqual([
      { value: { refused: 'unlinked', memoryId: 'mem_never_written' } }, { value: { refused: 'unlinked', memoryId: foreign } },
      { value: { refused: 'unlinked', memoryId: 'mem_gone_b' } }, { value: { refused: 'unlinked', memoryId: ours } },
      { value: [] }, { value: [6, 5, 3, 2, 1] }, { value: [4] }, { value: incidentOf(7, next) },
    ]);
    expect(added(side).slice(SEED_AUDIT_ROWS)).toEqual(opened(14, 7, next));
  });

  it('resolve moves an open row to resolved once with one resolve row; a resolved, a closed, a missing and a foreign row are refused and stay as they were', async () => {
    const { openings, calls } = seededIncidents();
    const side = await conforms([
      ...calls,
      resolve(3, T5, 'restarted the pool'), resolve(3, T5, 'again'), resolve(2, T5, 'again'), resolve(1, T5, 'again'), resolve(9, T5, 'none'), resolve(4, T5, 'not ours'),
      byId('incident', 3), byId('incident', 2), byId('incident', 1), byId('incident', 4, TENANT_B), ids('incident', { status: 'resolved', limit: 10 }),
    ]);
    const restarted = incidentOf(3, openings[2], { status: 'resolved', resolutionText: 'restarted the pool', resolvedAt: T5 });
    expect(side.outcomes.slice(SEED_CALLS)).toEqual([
      { value: restarted }, { value: { refused: 'status', status: 'resolved' } }, { value: { refused: 'status', status: 'resolved' } },
      { value: { refused: 'status', status: 'closed' } }, { value: { refused: 'missing' } }, { value: { refused: 'missing' } },
      { value: restarted }, { value: incidentOf(2, openings[1], DRAINED) }, { value: incidentOf(1, openings[0], { status: 'closed', closedAt: T4 }) },
      { value: incidentOf(4, openings[3]) }, { value: [3, 2] },
    ]);
    expect(added(side).slice(SEED_AUDIT_ROWS)).toEqual([auditRow(14, T5, 'incident_resolve', '3', { incident_id: 3 })]);
  });

  it('close retires an open and a resolved row with one close row each; a closed, a missing and a foreign row are refused and stay as they were', async () => {
    const { openings, calls } = seededIncidents();
    const side = await conforms([
      ...calls,
      close('incident', 3, T5, CLOSABLE), close('incident', 2, T5, CLOSABLE), close('incident', 1, T5, CLOSABLE), close('incident', 3, T5, CLOSABLE),
      close('incident', 9, T5, CLOSABLE), close('incident', 4, T5, CLOSABLE), close('incident', 5, T5, ['resolved']),
      byId('incident', 4, TENANT_B), byId('incident', 5), ids('incident', { status: 'closed', limit: 10 }),
    ]);
    expect(side.outcomes.slice(SEED_CALLS)).toEqual([
      { value: incidentOf(3, openings[2], { status: 'closed', closedAt: T5 }) },
      { value: incidentOf(2, openings[1], { ...DRAINED, status: 'closed', closedAt: T5 }) },
      { value: { refused: 'status', status: 'closed' } }, { value: { refused: 'status', status: 'closed' } },
      { value: { refused: 'missing' } }, { value: { refused: 'missing' } }, { value: { refused: 'status', status: 'open' } },
      { value: incidentOf(4, openings[3]) }, { value: incidentOf(5, openings[4]) }, { value: [3, 2, 1] },
    ]);
    expect(added(side).slice(SEED_AUDIT_ROWS)).toEqual([
      auditRow(14, T5, 'incident_close', '3', { incident_id: 3 }),
      auditRow(15, T5, 'incident_close', '2', { incident_id: 2 }),
    ]);
  });
});

interface PutOpts {
  readonly at?: string;
  readonly tenantId?: string;
  readonly supersedesId?: number;
  readonly tags?: readonly string[];
  /** Set over the mirror core builds, for the reads that turn on a memory's own columns. */
  readonly mirror?: Partial<MemoryEntry>;
}

/** A save whose fields and mirror the caller picks, for the reads that turn on them. */
function put<K extends SavableKind>(kind: K, fields: ObjectFields[K], opts: PutOpts = {}) {
  const { at = T1, tenantId = TENANT_A } = opts;
  const mirror: MemoryEntry = { ...objectMirror(fixture.dir, tenantId, kind, { content: `${kind} at ${at}`, tags: opts.tags ?? [] }), ...opts.mirror };
  const saved: ObjectSave<K> = { mirror, fields, supersedesId: opts.supersedesId, actor: ACTOR, at };
  const call: Call = (g) => {
    vi.setSystemTime(new Date(at));
    return g.saveObject(tenantId, kind, saved);
  };
  return { mirror, call };
}

describe('Objects, the policies in force at an instant', () => {
  const day = (monthDay: string): string => `2026-${monthDay}T00:00:00.000Z`;
  const policy = (policyName: string, from: string, to: string | null, opts: PutOpts = {}): Call =>
    put('policy', { policyName, policyText: `${policyName} from ${from}`, validFrom: day(from), validTo: to === null ? null : day(to) }, opts).call;
  const inForce = (asOf: string, more: { name?: string; limit?: number; tenantId?: string } = {}): Call => async (g) =>
    (await g.policiesInForce(more.tenantId ?? TENANT_A, { asOf, name: more.name, limit: more.limit ?? 10 })).map((p) => p.id);
  /** Ids 1 to 7: 1 is replaced by 2 from June, 3 and 6 share a start, 4 is closed, 5 is the other tenant's and 7 starts in May under the name 3 holds. */
  const seed = (): Call[] => [
    policy('retention', '01-01', null), policy('retention', '06-01', null, { at: T2, supersedesId: 1 }), policy('access', '02-01', '04-01'),
    policy('export', '01-15', null), policy('retention', '01-01', null, { tenantId: TENANT_B }), policy('travel', '02-01', null), policy('access', '05-01', null),
    close('policy', 4, T3, ['active']),
  ];
  const SEEDED = 8;

  it('keeps a row from its start to its end, a replaced row until its successor starts, and never a closed or a foreign row', async () => {
    const side = await conforms([
      ...seed(),
      inForce(day('03-01')), inForce(day('07-01')), inForce('2025-12-31T23:59:59.999Z'),
      inForce(day('02-01')), inForce('2026-01-31T23:59:59.999Z'), inForce(day('04-01')), inForce('2026-03-31T23:59:59.999Z'),
      inForce(day('06-01')), inForce('2026-05-31T23:59:59.999Z'),
      inForce(day('03-01'), { tenantId: TENANT_B }), inForce('2025-12-31T23:59:59.999Z', { tenantId: TENANT_B }),
    ]);
    expect(side.outcomes.slice(SEEDED)).toEqual([
      { value: [6, 3, 1] }, { value: [2, 7, 6] }, { value: [] },
      { value: [6, 3, 1] }, { value: [1] }, { value: [6, 1] }, { value: [6, 3, 1] },
      { value: [2, 7, 6] }, { value: [7, 6, 1] },
      { value: [5] }, { value: [] },
    ]);
    expect(added(side).map((e) => e.op).filter((op) => op !== 'policy_create' && op !== 'remember')).toEqual(['policy_supersede', 'policy_close']);
  });

  it('orders by the later start, then the larger id, under, at and over the cap, and keeps one name when asked', async () => {
    const side = await conforms([
      ...seed(),
      inForce(day('03-01'), { limit: 10 }), inForce(day('03-01'), { limit: 3 }), inForce(day('03-01'), { limit: 2 }), inForce(day('03-01'), { limit: 1 }),
      inForce(day('03-01'), { name: 'access' }), inForce(day('07-01'), { name: 'access' }), inForce(day('03-01'), { name: 'retention' }), inForce(day('07-01'), { name: 'retention' }),
      inForce(day('03-01'), { name: 'export' }), inForce(day('03-01'), { name: 'Access' }), inForce(day('03-01'), { name: '' }),
      (g) => g.policiesInForce(TENANT_A, { asOf: day('07-01'), name: 'retention', limit: 10 }),
    ]);
    expect(side.outcomes.slice(SEEDED, -1)).toEqual([
      { value: [6, 3, 1] }, { value: [6, 3, 1] }, { value: [6, 3] }, { value: [6] },
      { value: [3] }, { value: [7] }, { value: [1] }, { value: [2] },
      { value: [] }, { value: [] }, { value: [] },
    ]);
    expect(side.outcomes.at(-1)).toMatchObject({
      value: [{ id: 2, tenantId: TENANT_A, policyName: 'retention', validFrom: day('06-01'), validTo: null, version: 2, status: 'active', supersededBy: null, createdAt: T2 }],
    });
  });
});

describe('Objects, the active skills by name', () => {
  const skill = (name: string, opts: PutOpts = {}): Call => put('skill', { name, instructions: `how to ${name}`, trigger: null }, opts).call;
  const names = (limit: number, tenantId = TENANT_A): Call => async (g) => (await g.activeSkillsByName(tenantId, limit)).map((s) => `${s.id} ${s.skillName}`);

  it('orders names by their bytes, then by id, under, at and over the cap, and leaves out a replaced, a closed and a foreign skill', async () => {
    // U+FF5A sorts below U+1F600 by bytes and above it by UTF-16 code unit, so the pair tells the two orders apart.
    const side = await conforms([
      skill('triage'), skill('Zebra'), skill('alpha'), skill('theirs', { tenantId: TENANT_B }), skill('alpha', { at: T2 }), skill('\u{1F600} wide'), skill('ｚ wide'),
      skill('retired'), skill('triage', { at: T3, supersedesId: 1 }), close('skill', 8, T3, ['active']),
      names(10), names(6), names(3), names(1), names(10, TENANT_B),
      (g) => g.activeSkillsByName(TENANT_A, 1),
    ]);
    const ordered = ['2 Zebra', '3 alpha', '5 alpha', '9 triage', '7 ｚ wide', '6 \u{1F600} wide'];
    expect(side.outcomes.slice(10, -1)).toEqual([{ value: ordered }, { value: ordered }, { value: ordered.slice(0, 3) }, { value: ['2 Zebra'] }, { value: ['4 theirs'] }]);
    expect(side.outcomes.at(-1)).toMatchObject({ value: [{ id: 2, tenantId: TENANT_A, skillName: 'Zebra', instructions: 'how to Zebra', trigger: null, version: 1, status: 'active' }] });
  });
});

describe('Objects, the receipts a brief refresh cites', () => {
  const TAG = 'path:acme/web';
  const decision = (opts: PutOpts) => put('decision', { decisionText: 'noted', context: undefined }, opts);
  const receiptOf = (mirror: MemoryEntry): BriefReceipt => ({ id: mirror.id, created: mirror.created, source: mirror.source, content: mirror.content });
  const receipts = (tag: string, limit = 10, tenantId = TENANT_A): Call => (g) => g.briefReceipts(tenantId, tag, limit);
  /** Newest first, the larger id first on a shared instant. */
  const newestFirst = (mirrors: readonly MemoryEntry[]): BriefReceipt[] =>
    [...mirrors].sort((a, b) => Buffer.compare(Buffer.from(b.created), Buffer.from(a.created)) || Buffer.compare(Buffer.from(b.id), Buffer.from(a.id))).map(receiptOf);

  it('cites the memories that carry the whole tag, newest first, under, at and over the cap, and never a brief, a private scope or another tenant', async () => {
    const hits = [
      decision({ tags: [TAG], mirror: { created: T1 } }), decision({ tags: ['other', TAG], mirror: { created: T2 } }), decision({ tags: [TAG], mirror: { created: T2 } }),
      put('customer_note', { customer: 'initech', note: 'prefers email' }, { tags: ['PATH:Acme/Web'], mirror: { created: T3 } }),
      decision({ tags: [TAG], mirror: { created: T3, scope: 'team:web' } }),
    ];
    const misses = [
      decision({ tags: ['path:acme/website'] }), decision({ tags: ['path:acme'] }), decision({ tags: [] }),
      put('project_brief', { repo: 'acme/web', summary: 'storefront', receiptCount: undefined }, { tags: [TAG] }),
      decision({ tags: [TAG], mirror: { scope: 'slack:private:C1' } }), decision({ tags: [TAG], mirror: { scope: 'unknown:legacy' } }),
    ];
    const theirs = decision({ tags: [TAG], tenantId: TENANT_B });
    const saves = [...hits, ...misses, theirs].map((p) => p.call);
    const side = await conforms([
      ...saves, receipts(TAG), receipts(TAG, 5), receipts(TAG, 2), receipts('PATH:ACME/WEB'), receipts(TAG, 10, TENANT_B), receipts('path:nowhere'),
    ]);
    const cited = newestFirst(hits.map((p) => p.mirror));
    expect(cited.map((r) => r.created)).toEqual([T3, T3, T2, T2, T1]);
    expect(side.outcomes.slice(saves.length)).toEqual([
      { value: cited }, { value: cited }, { value: cited.slice(0, 2) }, { value: cited }, { value: [receiptOf(theirs.mirror)] }, { value: [] },
    ]);
  });

  it('matches the tag as written: a percent sign and an underscore stand for themselves, and only the ASCII letters fold', async () => {
    const tagged = (tag: string) => decision({ tags: [tag] });
    const [underscore, anyChar, percent, anyRun, accent, upperAccent, slashed] = [
      tagged('path:a_b'), tagged('path:axb'), tagged('path:100%'), tagged('path:100 percent'), tagged('path:café'), tagged('path:CAFÉ'), tagged('path:back\\slash'),
    ];
    const side = await conforms([
      ...[underscore, anyChar, percent, anyRun, accent, upperAccent, slashed].map((p) => p.call),
      receipts('path:a_b'), receipts('path:100%'), receipts('path:café'), receipts('path:CAFÉ'), receipts('path:%'), receipts('path:back\\slash'),
    ]);
    expect(side.outcomes.slice(7)).toEqual([
      { value: [receiptOf(underscore.mirror)] }, { value: [receiptOf(percent.mirror)] }, { value: [receiptOf(accent.mirror)] }, { value: [receiptOf(upperAccent.mirror)] },
      // A backslash is written doubled in the stored tag list, so the tag as given never finds it.
      { value: [] }, { value: [] },
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

  it('an incident open or resolve whose audit row is refused keeps no row, no mirror, no resolved status and no audit row', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-objects-atomic-'));
    try {
      cpSync(fixture.dir, root, { recursive: true });
      const store = sqliteStore(root);
      const objects = requireGroup(store, 'objects');
      const first = opening(1);
      await objects.openIncident(TENANT_A, first.open);
      refuseAuditOps(root, ['incident_open', 'incident_resolve']);
      const second = opening(2, { at: T2, links: [mirrorIdOf(first)] });
      const before = auditRowsAt(root);

      await expect(objects.openIncident(TENANT_A, second.open)).rejects.toThrow('audit row refused');
      await expect(objects.resolveIncident(TENANT_A, 1, { text: 'fixed', actor: ACTOR, at: T3 })).rejects.toThrow('audit row refused');

      expect(await objects.listObjects(TENANT_A, 'incident', { limit: 10 })).toEqual([incidentOf(1, first)]);
      expect(await store.entriesByIds([mirrorIdOf(first), mirrorIdOf(second)], TENANT_A)).toMatchObject([{ id: mirrorIdOf(first) }]);
      expect(auditRowsAt(root)).toEqual(before);
      await store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
