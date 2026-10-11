// A store other than hippo.db for the Objects group: it keeps the typed-object rows and the mirrors it is handed in Maps and never reads
// hippo.db's object tables, so a conformance test shows the port's own words are enough to build on.
import type { AuditOp } from '../../src/store/audit.js';
import { passesScopeFilterForRecall } from '../../src/core/recall-scope.js';
import type { AppendAuditOpts, AuditEvent, HippoStore, MemoryEntry } from '../../src/server.js';
import type { Incident, ObjectByKind, ObjectFields, ObjectKind, SavableKind } from '../../src/core/object-types.js';
import type { Objects } from '../../src/store/port.js';
import { inMemoryKeyAuditStore } from './in-memory-key-audit-store.js';
import type { StoreSide } from './store-conformance.js';

export interface InMemoryObjectsStore extends StoreSide {
  readonly store: HippoStore & { readonly objects: Objects };
}

type Tables = { readonly [K in ObjectKind]: Map<number, ObjectByKind[K]> };
type Metadata = AuditEvent['metadata'];

/** Byte order, as hippo.db compares text; JavaScript's own string order differs above the basic plane. */
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

const ID_KEY = {
  decision: 'decision_id', incident: 'incident_id', process: 'process_id', policy: 'policy_id', skill: 'skill_id', project_brief: 'brief_id', customer_note: 'note_id',
} as const satisfies Record<ObjectKind, string>;

const createOp = (kind: SavableKind): AuditOp => `${kind}_create`;
const supersedeOp = (kind: SavableKind): AuditOp => `${kind}_supersede`;
const closeOp = (kind: ObjectKind): AuditOp => `${kind}_close`;

/** What the store decides for a new row; the kind's own fields come from the save. */
interface NewRow {
  readonly id: number;
  readonly memoryId: string;
  readonly tenantId: string;
  readonly version: number;
  readonly changeSummary: string | null;
  readonly createdAt: string;
}

interface SaveRules<K extends SavableKind> {
  readonly row: (fields: ObjectFields[K], row: NewRow) => ObjectByKind[K];
  /** The create row's keys after the id. */
  readonly createKeys: (fields: ObjectFields[K], version: number) => Metadata;
  /** Set for a versioned kind; a decision carries no version. */
  readonly versionOf?: (row: ObjectByKind[K]) => number;
  /** Keys the supersede row stores after its own. */
  readonly supersedeKeys?: (fields: ObjectFields[K]) => Metadata;
}

const head = (r: NewRow) => ({ id: r.id, memoryId: r.memoryId, tenantId: r.tenantId });
const tail = (r: NewRow) => ({
  version: r.version, status: 'active' as const, supersededBy: null, supersededAt: null, changeSummary: r.changeSummary, closedAt: null, createdAt: r.createdAt,
});
const versionOf = (row: { readonly version: number }): number => row.version;
const refreshKeys = (f: ObjectFields['project_brief']): Metadata => (f.receiptCount === undefined ? { refreshed: false } : { refreshed: true, receipt_count: f.receiptCount });

type SaveRulesByKind = { readonly [K in SavableKind]: SaveRules<K> };

const SAVE_RULES: SaveRulesByKind = {
  decision: {
    row: (f, r) => ({
      ...head(r), decisionText: f.decisionText, context: f.context ?? null, status: 'active', supersededBy: null, supersededAt: null, closedAt: null, createdAt: r.createdAt,
    }),
    createKeys: (f) => ({ has_context: Boolean(f.context) }),
  },
  process: {
    row: (f, r) => ({ ...head(r), processName: f.processName, description: f.description ?? null, steps: [...f.steps], ...tail(r) }),
    createKeys: (f, version) => ({ version, step_count: f.steps.length, has_description: Boolean(f.description) }),
    versionOf,
  },
  policy: {
    row: (f, r) => ({ ...head(r), policyName: f.policyName, policyText: f.policyText, validFrom: f.validFrom, validTo: f.validTo, ...tail(r) }),
    createKeys: (f, version) => ({ version, open_ended: f.validTo === null }),
    versionOf,
  },
  skill: {
    row: (f, r) => ({ ...head(r), skillName: f.name, instructions: f.instructions, trigger: f.trigger, ...tail(r) }),
    createKeys: (f, version) => ({ version, has_trigger: f.trigger !== null }),
    versionOf,
  },
  project_brief: {
    row: (f, r) => ({ ...head(r), repo: f.repo, summary: f.summary, ...tail(r) }),
    createKeys: (f, version) => ({ repo: f.repo, version, ...refreshKeys(f) }),
    versionOf,
    supersedeKeys: refreshKeys,
  },
  customer_note: {
    row: (f, r) => ({ ...head(r), customer: f.customer, note: f.note, ...tail(r) }),
    createKeys: (f, version) => ({ customer: f.customer, version }),
    versionOf,
  },
};

function saveRules<K extends SavableKind>(kind: K): SaveRules<K> {
  return SAVE_RULES[kind];
}

type FilterValues = { readonly [K in ObjectKind]?: (row: ObjectByKind[K]) => string };

const FILTER_VALUE: FilterValues = {
  project_brief: (row) => row.repo,
  customer_note: (row) => row.customer,
};

function filterValue<K extends ObjectKind>(kind: K): ((row: ObjectByKind[K]) => string) | undefined {
  return FILTER_VALUE[kind];
}

/** SQLite folds only the ASCII letters, in LOWER and in LIKE alike. */
const asciiFolded = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

const nextId = (table: ReadonlyMap<number, unknown>): number => Math.max(0, ...table.keys()) + 1;
const rememberRow = (mirror: MemoryEntry, actor: string): AppendAuditOpts =>
  ({ tenantId: mirror.tenantId, actor, op: 'remember', targetId: mirror.id, metadata: { kind: mirror.kind ?? 'distilled', scope: mirror.scope ?? null } });

export function inMemoryObjectsStore(hippoRoot: string): InMemoryObjectsStore {
  const base = inMemoryKeyAuditStore(hippoRoot);
  const tables: Tables = { decision: new Map(), incident: new Map(), process: new Map(), policy: new Map(), skill: new Map(), project_brief: new Map(), customer_note: new Map() };
  const mirrors = new Map<string, MemoryEntry>();
  const tableOf = <K extends ObjectKind>(kind: K): Map<number, ObjectByKind[K]> => tables[kind];
  const owned = <K extends ObjectKind>(kind: K, tenantId: string, id: number): ObjectByKind[K] | undefined => {
    const row = tableOf(kind).get(id);
    return row?.tenantId === tenantId ? row : undefined;
  };

  const objects: Objects = {
    async listObjects(tenantId, kind, query) {
      const column = filterValue(kind);
      const { after } = query;
      const hits = [...tableOf(kind).values()].filter((row) => {
        if (row.tenantId !== tenantId || (query.status !== undefined && row.status !== query.status)) return false;
        if (query.filter !== undefined && column && column(row) !== query.filter) return false;
        if (!after) return true;
        const byKey = byBytes(row.createdAt, String(after.key));
        return byKey < 0 || (byKey === 0 && row.id < Number(after.id));
      });
      return structuredClone(hits.sort((a, b) => byBytes(b.createdAt, a.createdAt) || b.id - a.id).slice(0, query.limit));
    },
    async objectById(tenantId, kind, id) {
      return structuredClone(owned(kind, tenantId, id) ?? null);
    },
    async closeObject(tenantId, kind, id, close) {
      const row = owned(kind, tenantId, id);
      if (!row) return { refused: 'missing' };
      if (!close.from.includes(row.status)) return { refused: 'status', status: row.status };
      const closed = { ...row, status: 'closed', closedAt: close.at };
      // The row is kept only once its audit row is in, as one transaction would have it.
      await base.store.appendAuditEvents([{ tenantId, actor: close.actor, op: closeOp(kind), targetId: String(id), metadata: { [ID_KEY[kind]]: id } }]);
      tableOf(kind).set(id, closed);
      return structuredClone(closed);
    },
    async saveObject(tenantId, kind, save) {
      const rules = saveRules(kind);
      const table = tableOf(kind);
      const replaced = save.supersedesId === undefined ? undefined : owned(kind, tenantId, save.supersedesId);
      if (save.supersedesId !== undefined && !replaced) return { refused: 'missing' };
      if (replaced && replaced.status !== 'active') return { refused: 'status', status: replaced.status };
      const id = nextId(table);
      const version = replaced && rules.versionOf ? rules.versionOf(replaced) + 1 : 1;
      const changeSummary = replaced && rules.versionOf ? save.changeSummary ?? null : null;
      const row = rules.row(save.fields, { id, memoryId: save.mirror.id, tenantId, version, changeSummary, createdAt: save.at });
      const events: AppendAuditOpts[] = [];
      if (replaced) {
        const own: Metadata = { [ID_KEY[kind]]: replaced.id, superseded_by: id };
        if (rules.versionOf) own.new_version = version;
        events.push({ tenantId, actor: save.actor, op: supersedeOp(kind), targetId: String(replaced.id), metadata: { ...own, ...rules.supersedeKeys?.(save.fields) } });
      }
      events.push({ tenantId, actor: save.actor, op: createOp(kind), targetId: String(id), metadata: { [ID_KEY[kind]]: id, ...rules.createKeys(save.fields, version) } });
      const { mirror } = save;
      events.push(rememberRow(mirror, save.actor));
      // The rows are kept only once every audit row is in, as one transaction would have it.
      await base.store.appendAuditEvents(events);
      if (replaced) table.set(replaced.id, { ...replaced, status: 'superseded', supersededBy: id, supersededAt: save.at });
      table.set(id, row);
      mirrors.set(mirror.id, structuredClone(mirror));
      return structuredClone(row);
    },
    async openIncident(tenantId, open) {
      const { mirror, fields } = open;
      // The mirror goes in ahead of the link check, so an incident may cite its own mirror.
      const unlinked = fields.linkedMemoryIds.find((linkId) => (linkId === mirror.id ? mirror : mirrors.get(linkId))?.tenantId !== tenantId);
      if (unlinked !== undefined) return { refused: 'unlinked', memoryId: unlinked };
      const id = nextId(tables.incident);
      const row: Incident = {
        id, memoryId: mirror.id, tenantId, incidentText: fields.incidentText, context: fields.context ?? null, status: 'open',
        resolutionText: null, resolvedAt: null, closedAt: null, linkedMemoryIds: [...fields.linkedMemoryIds], createdAt: open.at,
      };
      const metadata = { incident_id: id, has_context: Boolean(fields.context), linked_memory_count: fields.linkedMemoryIds.length };
      await base.store.appendAuditEvents([{ tenantId, actor: open.actor, op: 'incident_open', targetId: String(id), metadata }, rememberRow(mirror, open.actor)]);
      tables.incident.set(id, row);
      mirrors.set(mirror.id, structuredClone(mirror));
      return structuredClone(row);
    },
    async resolveIncident(tenantId, id, resolve) {
      const row = owned('incident', tenantId, id);
      if (!row) return { refused: 'missing' };
      if (row.status !== 'open') return { refused: 'status', status: row.status };
      const resolved: Incident = { ...row, status: 'resolved', resolutionText: resolve.text, resolvedAt: resolve.at };
      await base.store.appendAuditEvents([{ tenantId, actor: resolve.actor, op: 'incident_resolve', targetId: String(id), metadata: { incident_id: id } }]);
      tables.incident.set(id, resolved);
      return structuredClone(resolved);
    },
    async policiesInForce(tenantId, query) {
      const { asOf } = query;
      const replacedLater = (id: number | null): boolean => {
        const successor = id === null ? undefined : tables.policy.get(id);
        return successor !== undefined && byBytes(successor.validFrom, asOf) > 0;
      };
      const hits = [...tables.policy.values()].filter((p) =>
        p.tenantId === tenantId && p.status !== 'closed' && (query.name === undefined || p.policyName === query.name)
        && byBytes(p.validFrom, asOf) <= 0 && (p.validTo === null || byBytes(asOf, p.validTo) < 0)
        && (p.status === 'active' || replacedLater(p.supersededBy)));
      return structuredClone(hits.sort((a, b) => byBytes(b.validFrom, a.validFrom) || b.id - a.id).slice(0, query.limit));
    },
    async activeSkillsByName(tenantId, limit) {
      const hits = [...tables.skill.values()].filter((s) => s.tenantId === tenantId && s.status === 'active');
      return structuredClone(hits.sort((a, b) => byBytes(a.skillName, b.skillName) || a.id - b.id).slice(0, limit));
    },
    async briefReceipts(tenantId, tag, limit) {
      const quoted = asciiFolded(`"${tag}"`);
      const hits = [...mirrors.values()].filter((m) =>
        m.tenantId === tenantId && m.source !== 'project_brief' && passesScopeFilterForRecall(m.scope ?? null, undefined)
        && asciiFolded(JSON.stringify(m.tags)).includes(quoted));
      hits.sort((a, b) => byBytes(b.created, a.created) || byBytes(b.id, a.id));
      return hits.slice(0, limit).map((m) => ({ id: m.id, created: m.created, source: m.source, content: m.content }));
    },
  };

  const store: InMemoryObjectsStore['store'] = {
    ...base.store,
    async entriesByIds(ids, tenantId) {
      const wanted = new Set(ids.slice(0, 500));
      const found = [...mirrors.values()].filter((e) => wanted.has(e.id) && (tenantId === undefined || e.tenantId === tenantId));
      return structuredClone(found.sort((a, b) => byBytes(a.created, b.created) || byBytes(a.content, b.content) || byBytes(a.id, b.id)));
    },
    objects,
  };
  return { store, auditRows: base.auditRows };
}
