// A store other than hippo.db for the Objects group: it copies the typed-object rows out of hippo.db once, then keeps them and
// the mirrors it is handed in Maps, so a conformance test shows the port's own words are enough to build on.
import type { AuditOp } from '../../src/store/audit.js';
import { closeHippoDb, openHippoDb } from '../../src/db.js';
import type { AppendAuditOpts, AuditEvent, HippoStore, MemoryEntry } from '../../src/server.js';
import type { ObjectByKind, ObjectFields, ObjectKind, SavableKind } from '../../src/store/object-types.js';
import type { Objects } from '../../src/store/port.js';
import { rowSpec, type RowByKind } from '../../src/store/sqlite/object-rows.js';
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

function copyTable<K extends ObjectKind>(hippoRoot: string, kind: K): Map<number, ObjectByKind[K]> {
  const spec = rowSpec(kind);
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: the SELECT names spec.cols, the columns the kind's row declares.
    const rows = db.prepare(`SELECT ${spec.cols} FROM ${spec.table}`).all() as RowByKind[K][];
    return new Map(rows.map((row) => [row.id, spec.rowTo(row)]));
  } finally {
    closeHippoDb(db);
  }
}

export function inMemoryObjectsStore(hippoRoot: string): InMemoryObjectsStore {
  const base = inMemoryKeyAuditStore(hippoRoot);
  const tables: Tables = {
    decision: copyTable(hippoRoot, 'decision'), incident: copyTable(hippoRoot, 'incident'), process: copyTable(hippoRoot, 'process'),
    policy: copyTable(hippoRoot, 'policy'), skill: copyTable(hippoRoot, 'skill'), project_brief: copyTable(hippoRoot, 'project_brief'),
    customer_note: copyTable(hippoRoot, 'customer_note'),
  };
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
      const id = Math.max(0, ...table.keys()) + 1;
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
      events.push({ tenantId: mirror.tenantId, actor: save.actor, op: 'remember', targetId: mirror.id, metadata: { kind: mirror.kind ?? 'distilled', scope: mirror.scope ?? null } });
      // The rows are kept only once every audit row is in, as one transaction would have it.
      await base.store.appendAuditEvents(events);
      if (replaced) table.set(replaced.id, { ...replaced, status: 'superseded', supersededBy: id, supersededAt: save.at });
      table.set(id, row);
      mirrors.set(mirror.id, structuredClone(mirror));
      return structuredClone(row);
    },
    async mirrorsOnDefaultHalfLife() {
      return true;
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
