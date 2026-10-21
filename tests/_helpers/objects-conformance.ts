// Calls, expected rows and hooks the objects-conformance tests share; useObjectsConformance seeds the two-tenant store.
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { listAuditEventsAfter } from '../../src/store/sqlite/audit.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { objectMirror } from '../../src/domain/objects/lifecycle.js';
import { auditHighId } from '../_helpers/root-forms.js';
import type {
  BriefReceipt,
  Incident,
  ObjectByKind,
  ObjectFields,
  ObjectKind,
  ObjectRefusal,
  SavableKind,
} from '../../src/base/records/object-types.js';
import type { IncidentOpen, IncidentOpenRefusal, ObjectListQuery, ObjectSave } from '../../src/store/port.js';
import {
  onBothStores,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type SideResult,
  type TwoTenantFixture,
  expectSameOutcomes,
} from '../_helpers/store-conformance.js';
import { loadConfig } from '../../src/base/config/config.js';
import type { AuditEvent } from '../../src/store/port/types.js';
import type { AuditOp } from '../../src/base/records/audit-ops.js';
import { ALL_TENANTS, type TenantId } from '../../src/base/util/tenant.js';

const NOW = '2026-03-01T12:00:00.000Z';
export const T1 = '2026-03-01T12:00:01.000Z';
export const T2 = '2026-03-01T12:00:02.000Z';
export const T3 = '2026-03-01T12:00:03.000Z';
export const T4 = '2026-03-01T12:00:04.000Z';
export const T5 = '2026-03-01T12:00:05.000Z';
export const ACTOR = 'api_key:caller';

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

export const odd = (n: number): boolean => n % 2 === 1;
const refreshKeys = (n: number): Metadata => (odd(n) ? { refreshed: false } : { refreshed: true, receipt_count: n });

export const CASES: readonly KindCase[] = [
  {
    kind: 'decision',
    idKey: 'decision_id',
    versioned: false,
    filtered: false,
    fields: (n) => ({ decisionText: `decision ${n}`, context: odd(n) ? `context ${n}` : undefined }),
    own: (n) => ({ decisionText: `decision ${n}`, context: odd(n) ? `context ${n}` : null }),
    createKeys: (n) => ({ has_context: odd(n) }),
  },
  {
    kind: 'process',
    idKey: 'process_id',
    versioned: true,
    filtered: false,
    fields: (n) => ({
      processName: `process ${n}`,
      description: odd(n) ? `how ${n}` : undefined,
      steps: ['plan', `ship ${n}`],
    }),
    own: (n) => ({
      processName: `process ${n}`,
      description: odd(n) ? `how ${n}` : null,
      steps: ['plan', `ship ${n}`],
    }),
    createKeys: (n, version) => ({ version, step_count: 2, has_description: odd(n) }),
  },
  {
    kind: 'policy',
    idKey: 'policy_id',
    versioned: true,
    filtered: false,
    fields: (n) => ({
      policyName: `policy ${n}`,
      policyText: `rule ${n}`,
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: odd(n) ? null : '2027-01-01T00:00:00.000Z',
    }),
    own: (n) => ({
      policyName: `policy ${n}`,
      policyText: `rule ${n}`,
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: odd(n) ? null : '2027-01-01T00:00:00.000Z',
    }),
    createKeys: (n, version) => ({ version, open_ended: odd(n) }),
  },
  {
    kind: 'skill',
    idKey: 'skill_id',
    versioned: true,
    filtered: false,
    fields: (n) => ({ name: `skill ${n}`, instructions: `do ${n}`, trigger: odd(n) ? `when ${n}` : null }),
    own: (n) => ({ skillName: `skill ${n}`, instructions: `do ${n}`, trigger: odd(n) ? `when ${n}` : null }),
    createKeys: (n, version) => ({ version, has_trigger: odd(n) }),
  },
  {
    kind: 'project_brief',
    idKey: 'brief_id',
    versioned: true,
    filtered: true,
    fields: (n, group) => ({ repo: group, summary: `summary ${n}`, receiptCount: odd(n) ? undefined : n }),
    own: (n, group) => ({ repo: group, summary: `summary ${n}` }),
    createKeys: (n, version, group) => ({ repo: group, version, ...refreshKeys(n) }),
    supersedeKeys: refreshKeys,
  },
  {
    kind: 'customer_note',
    idKey: 'note_id',
    versioned: true,
    filtered: true,
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
type Value =
  | AnyObject
  | AnyObject[]
  | number[]
  | ObjectRefusal
  | IncidentOpenRefusal
  | MirrorView[]
  | BriefReceipt[]
  | string[]
  | null;
export type Call = GroupCall<'objects', Value>;
type Side = SideResult<Value>;

export let fixture: TwoTenantFixture;
let baseline: Side;
let nextAuditId: number;

export async function conforms(calls: readonly Call[]): Promise<Side> {
  const sides = await onBothStores(fixture, 'objects', calls);
  expectSameOutcomes(sides);
  return sides.sqlite;
}

/** One save, built once per call list so both stores are handed the same mirror id. */
interface Draft {
  readonly n: number;
  readonly group: string;
  readonly tenantId: string;
  readonly save: ObjectSave;
}

export interface DraftOptions {
  readonly at?: string;
  readonly group?: string;
  readonly tenantId?: string;
  readonly supersedesId?: number;
  readonly changeSummary?: string;
}

export function saving(c: KindCase, n: number, opts: DraftOptions = {}): Draft {
  const { at = T1, group = 'alpha', tenantId = TENANT_A } = opts;
  const mirror = objectMirror(loadConfig(fixture.dir).defaultHalfLifeDays, tenantId, c.kind, {
    content: `${c.kind} ${n}`,
    tags: ['conformance'],
  });
  return {
    n,
    group,
    tenantId,
    save: {
      mirror,
      fields: c.fields(n, group),
      supersedesId: opts.supersedesId,
      changeSummary: opts.changeSummary,
      actor: ACTOR,
      at,
    },
  };
}

/** Each write sets the clock inside the call, so both stores stamp its audit rows with the same time. */
export const save =
  (c: KindCase, d: Draft): Call =>
  (g) => {
    vi.setSystemTime(new Date(d.save.at));
    return g.saveObject(d.tenantId, c.kind, d.save);
  };
export const close =
  <K extends ObjectKind>(
    kind: K,
    id: number,
    at: string,
    from: readonly ObjectByKind[K]['status'][],
    tenantId = TENANT_A,
  ): Call =>
  (g) => {
    vi.setSystemTime(new Date(at));
    return g.closeObject(tenantId, kind, id, { from, actor: ACTOR, at });
  };
export const retire = (c: KindCase, id: number, at: string, tenantId = TENANT_A): Call =>
  close(c.kind, id, at, ['active'], tenantId);
export const byId =
  (kind: ObjectKind, id: number, tenantId = TENANT_A): Call =>
  (g) =>
    g.objectById(tenantId, kind, id);
export const list =
  <K extends ObjectKind>(kind: K, query: ObjectListQuery<K>, tenantId = TENANT_A): Call =>
  (g) =>
    g.listObjects(tenantId, kind, query);
export const ids =
  <K extends ObjectKind>(kind: K, query: ObjectListQuery<K>, tenantId = TENANT_A): Call =>
  async (g) =>
    (await g.listObjects(tenantId, kind, query)).map((o) => o.id);
export const mirrorViews =
  (mirrorIds: readonly string[], tenantId: TenantId = ALL_TENANTS): Call =>
  async (_g, store) =>
    (await store.entriesByIds(mirrorIds, tenantId)).map((e) => ({
      id: e.id,
      tenantId: e.tenantId,
      content: e.content,
      tags: e.tags,
    }));
export const mirrorsOf = (drafts: readonly Draft[], tenantId?: string): Call =>
  mirrorViews(
    drafts.map((d) => d.save.mirror.id),
    tenantId,
  );

interface RowState {
  readonly version?: number;
  readonly changeSummary?: string;
  readonly status?: 'superseded' | 'closed';
  readonly supersededBy?: number;
  readonly supersededAt?: string;
  readonly closedAt?: string;
}

/** The row a save made, as it reads after the writes `state` names. */
export function rowOf(c: KindCase, id: number, d: Draft, state: RowState = {}) {
  const head = { id, memoryId: d.save.mirror.id, tenantId: d.tenantId, ...c.own(d.n, d.group) };
  const tail = {
    status: state.status ?? 'active',
    supersededBy: state.supersededBy ?? null,
    supersededAt: state.supersededAt ?? null,
    closedAt: state.closedAt ?? null,
    createdAt: d.save.at,
  };
  return c.versioned
    ? { ...head, version: state.version ?? 1, changeSummary: state.changeSummary ?? null, ...tail }
    : { ...head, ...tail };
}

export const mirrorView = (c: KindCase, d: Draft): MirrorView => ({
  id: d.save.mirror.id,
  tenantId: d.tenantId,
  content: `${c.kind} ${d.n}`,
  tags: [c.kind, 'conformance'],
});

/** The rows a run added, each under the next audit id in turn. */
export function added(side: Side): AuditEvent[] {
  return side.audit.slice(baseline.audit.length);
}

export function auditRow(
  nth: number,
  ts: string,
  op: AuditOp,
  targetId: string,
  metadata: Metadata,
  tenantId = TENANT_A,
): AuditEvent {
  return { id: nextAuditId + nth, ts, tenantId, actor: ACTOR, op, targetId, metadata };
}

export const createOp = (kind: SavableKind): AuditOp => `${kind}_create`;
export const supersedeOp = (kind: SavableKind): AuditOp => `${kind}_supersede`;
export const closeOp = (kind: ObjectKind): AuditOp => `${kind}_close`;

export const created = (c: KindCase, nth: number, id: number, d: Draft, version = 1): AuditEvent =>
  auditRow(
    nth,
    d.save.at,
    createOp(c.kind),
    String(id),
    { [c.idKey]: id, ...c.createKeys(d.n, version, d.group) },
    d.tenantId,
  );
export const remembered = (nth: number, d: Draft): AuditEvent =>
  auditRow(nth, d.save.at, 'remember', d.save.mirror.id, { kind: 'distilled', scope: null }, d.tenantId);
/** `d` is the successor that replaced row `replaced` and took id `id`. */
export function superseded(
  c: KindCase,
  nth: number,
  replaced: number,
  id: number,
  d: Draft,
  version: number,
): AuditEvent {
  const own: Metadata = { [c.idKey]: replaced, superseded_by: id };
  if (c.versioned) own.new_version = version;
  return auditRow(nth, d.save.at, supersedeOp(c.kind), String(replaced), { ...own, ...c.supersedeKeys?.(d.n) });
}

export function auditRowsAt(root: string): AuditEvent[] {
  const db = openHippoDb(root);
  try {
    return listAuditEventsAfter(db, { tenantId: ALL_TENANTS, afterId: 0, limit: 10_000 });
  } finally {
    closeHippoDb(db);
  }
}

/** One incident to open, built once per call list so both stores are handed the same mirror id. */
interface Opening {
  readonly n: number;
  readonly tenantId: string;
  readonly open: IncidentOpen;
}

interface OpeningOptions {
  readonly at?: string;
  readonly tenantId?: string;
  readonly context?: string;
  readonly links?: readonly string[];
}

export function opening(n: number, opts: OpeningOptions = {}): Opening {
  const { at = T1, tenantId = TENANT_A } = opts;
  const mirror = objectMirror(loadConfig(fixture.dir).defaultHalfLifeDays, tenantId, 'incident', {
    content: `incident ${n}`,
    tags: ['conformance'],
  });
  return {
    n,
    tenantId,
    open: {
      mirror,
      fields: { incidentText: `incident ${n}`, context: opts.context, linkedMemoryIds: opts.links ?? [] },
      actor: ACTOR,
      at,
    },
  };
}

export const linkedTo = (o: Opening, links: readonly string[]): Opening => ({
  ...o,
  open: { ...o.open, fields: { ...o.open.fields, linkedMemoryIds: links } },
});
export const mirrorIdOf = (o: Opening): string => o.open.mirror.id;

export const openIncident =
  (o: Opening): Call =>
  (g) => {
    vi.setSystemTime(new Date(o.open.at));
    return g.openIncident(o.tenantId, o.open);
  };
export const resolve =
  (id: number, at: string, text: string, tenantId = TENANT_A): Call =>
  (g) => {
    vi.setSystemTime(new Date(at));
    return g.resolveIncident(tenantId, id, { text, actor: ACTOR, at });
  };

/** The row an open made, as it reads after the writes `state` names. */
export function incidentOf(id: number, o: Opening, state: Partial<Incident> = {}): Incident {
  const { incidentText, context, linkedMemoryIds } = o.open.fields;
  return {
    id,
    memoryId: mirrorIdOf(o),
    tenantId: o.tenantId,
    incidentText,
    context: context ?? null,
    status: 'open',
    resolutionText: null,
    resolvedAt: null,
    closedAt: null,
    linkedMemoryIds: [...linkedMemoryIds],
    createdAt: o.open.at,
    ...state,
  };
}

export const incidentMirror = (o: Opening): MirrorView => ({
  id: mirrorIdOf(o),
  tenantId: o.tenantId,
  content: `incident ${o.n}`,
  tags: ['incident', 'conformance'],
});

/** The two rows one open appends, the open row first. */
export function opened(nth: number, id: number, o: Opening): AuditEvent[] {
  const { context, linkedMemoryIds } = o.open.fields;
  const metadata = {
    incident_id: id,
    has_context: context !== undefined && context !== '',
    linked_memory_count: linkedMemoryIds.length,
  };
  return [
    auditRow(nth, o.open.at, 'incident_open', String(id), metadata, o.tenantId),
    auditRow(nth + 1, o.open.at, 'remember', mirrorIdOf(o), { kind: 'distilled', scope: null }, o.tenantId),
  ];
}

export const CLOSABLE = ['open', 'resolved'] as const;
export const DRAINED = { status: 'resolved', resolutionText: 'drained the queue', resolvedAt: T4 } as const;

/** Incident ids 1 to 6, id 4 in the other tenant: two instants each shared by two of the tenant's rows, then 2 resolved and 1 closed. */
export function seededIncidents() {
  const openings = [
    opening(1, { context: 'eu-west' }),
    opening(2),
    opening(3, { at: T2 }),
    opening(4, { at: T2, tenantId: TENANT_B }),
    opening(5, { at: T2 }),
    opening(6, { at: T3 }),
  ];
  return {
    openings,
    calls: [...openings.map(openIncident), resolve(2, T4, 'drained the queue'), close('incident', 1, T4, CLOSABLE)],
  };
}
export const SEED_CALLS = 8;
export const SEED_AUDIT_ROWS = 14;

export function useObjectsConformance() {
  beforeAll(async () => {
    fixture = seedTwoTenants();
    nextAuditId = auditHighId(fixture.dir) + 1;
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
}
