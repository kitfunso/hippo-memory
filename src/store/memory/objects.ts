// The in-memory Objects group: the typed-object rows, each save landing with its mirror memory in one staged write.
import type {
  BriefReceipt,
  Incident,
  ObjectByKind,
  ObjectKind,
  ObjectRefusal,
  Policy,
  SavableKind,
} from '../../base/records/object-types.js';
import { passesScopeFilterForRecall } from '../../base/scope/recall-scope.js';
import type { IncidentOpen, IncidentOpenRefusal, ObjectListQuery, ObjectSave, Objects } from '../port/objects.js';
import type { PoliciesInForceQuery } from '../port/objects.js';
import type { AppendAuditOpts } from '../port/types.js';
import { closeOp, createOp, filterValue, ID_KEY, saveRules, supersedeOp } from './object-rules.js';
import { byBytes, type DescendingKeyset, isBelow, newestFirst } from '../rules/order.js';
import { appendAudit, asciiFolded, nextId, peekId } from './rows.js';
import { put, stage } from './staged.js';
import type { MemoryTables } from './tables.js';

const tableOf = <K extends ObjectKind>(t: MemoryTables, kind: K): Map<number, ObjectByKind[K]> => t.objects[kind];
/** Each kind's hippo.db table, whose AUTOINCREMENT sequence its ids follow. */
const TABLE_OF = {
  decision: 'decisions',
  incident: 'incidents',
  process: 'processes',
  policy: 'policies',
  skill: 'skills',
  project_brief: 'project_briefs',
  customer_note: 'customer_notes',
} as const satisfies Record<ObjectKind, string>;

function owned<K extends ObjectKind>(
  t: MemoryTables,
  kind: K,
  tenantId: string,
  id: number,
): ObjectByKind[K] | undefined {
  const row = tableOf(t, kind).get(id);
  return row?.tenantId === tenantId ? row : undefined;
}

/** Drops a staged incident whose linked id is no memory of the tenant. */
class Unlinked extends Error {
  constructor(readonly memoryId: string) {
    super(memoryId);
  }
}

const BY_CREATED_AT: DescendingKeyset<{ readonly createdAt: string; readonly id: number }> = {
  key: (row) => row.createdAt,
  intId: (row) => row.id,
};

function listIn<K extends ObjectKind>(t: MemoryTables, tenantId: string, kind: K, query: ObjectListQuery<K>) {
  const column = filterValue(kind);
  const { after } = query;
  const hits = [...tableOf(t, kind).values()].filter((row) => {
    if (row.tenantId !== tenantId || (query.status !== undefined && row.status !== query.status)) return false;
    if (query.filter !== undefined && column && column(row) !== query.filter) return false;
    return !after || isBelow(BY_CREATED_AT, row, after);
  });
  return structuredClone(hits.sort(newestFirst(BY_CREATED_AT)).slice(0, query.limit));
}

/** Where a save lands: the tenant, the new row's id and version, and the id of the row it replaces. */
interface SaveSlot {
  readonly tenantId: string;
  readonly id: number;
  readonly version: number;
  readonly replaced?: number;
}

/** The supersede row (when a row is replaced) and the create row, in that order. */
function saveEvents<K extends SavableKind>(kind: K, save: ObjectSave<K>, slot: SaveSlot): AppendAuditOpts[] {
  const rules = saveRules(kind);
  const { tenantId, id, version, replaced } = slot;
  const events: AppendAuditOpts[] = [];
  if (replaced !== undefined) {
    const own = { [ID_KEY[kind]]: replaced, superseded_by: id };
    if (rules.versionOf) own.new_version = version;
    const metadata = { ...own, ...rules.supersedeKeys?.(save.fields) };
    events.push({ tenantId, actor: save.actor, op: supersedeOp(kind), targetId: String(replaced), metadata });
  }
  const metadata = { [ID_KEY[kind]]: id, ...rules.createKeys(save.fields, version) };
  events.push({ tenantId, actor: save.actor, op: createOp(kind), targetId: String(id), metadata });
  return events;
}

function saveIn<K extends SavableKind>(t: MemoryTables, tenantId: string, kind: K, save: ObjectSave<K>) {
  const rules = saveRules(kind);
  const table = tableOf(t, kind);
  const replaced = save.supersedesId === undefined ? undefined : owned(t, kind, tenantId, save.supersedesId);
  if (save.supersedesId !== undefined && !replaced) return { refused: 'missing' } as const;
  if (replaced && replaced.status !== 'active') return { refused: 'status', status: replaced.status } as const;
  const id = peekId(t, TABLE_OF[kind]);
  const version = replaced && rules.versionOf ? rules.versionOf(replaced) + 1 : 1;
  const changeSummary = replaced && rules.versionOf ? (save.changeSummary ?? null) : null;
  const row = rules.row(save.fields, {
    id,
    memoryId: save.mirror.id,
    tenantId,
    version,
    changeSummary,
    createdAt: save.at,
  });
  return stage(t, save.actor, (tx) => {
    const at = tx.audit.length;
    put(t, tx, save.mirror, save.actor);
    const events = saveEvents(kind, save, { tenantId, id, version, replaced: replaced?.id });
    tx.audit.splice(at, 0, ...events);
    if (replaced) {
      table.set(replaced.id, { ...replaced, status: 'superseded', supersededBy: id, supersededAt: save.at });
    }
    table.set(nextId(t, TABLE_OF[kind]), row);
    return structuredClone(row);
  });
}

function openIn(t: MemoryTables, tenantId: string, open: IncidentOpen): Incident | IncidentOpenRefusal {
  const { mirror, fields } = open;
  try {
    return stage(t, open.actor, (tx) => {
      const at = tx.audit.length;
      put(t, tx, mirror, open.actor);
      const unlinked = fields.linkedMemoryIds.find((linkId) => tx.rows.get(linkId)?.tenantId !== tenantId);
      if (unlinked !== undefined) throw new Unlinked(unlinked);
      const id = peekId(t, TABLE_OF.incident);
      const row: Incident = {
        id,
        memoryId: mirror.id,
        tenantId,
        incidentText: fields.incidentText,
        context: fields.context ?? null,
        status: 'open',
        resolutionText: null,
        resolvedAt: null,
        closedAt: null,
        linkedMemoryIds: [...fields.linkedMemoryIds],
        createdAt: open.at,
      };
      const count = fields.linkedMemoryIds.length;
      const metadata = { incident_id: id, has_context: Boolean(fields.context), linked_memory_count: count };
      tx.audit.splice(at, 0, { tenantId, actor: open.actor, op: 'incident_open', targetId: String(id), metadata });
      t.objects.incident.set(nextId(t, TABLE_OF.incident), row);
      return structuredClone(row);
    });
  } catch (err) {
    if (err instanceof Unlinked) return { refused: 'unlinked', memoryId: err.memoryId };
    throw err;
  }
}

function closeIn<K extends ObjectKind>(
  t: MemoryTables,
  tenantId: string,
  kind: K,
  id: number,
  close: { from: readonly ObjectByKind[K]['status'][]; actor: string; at: string },
): ObjectByKind[K] | ObjectRefusal {
  const row = owned(t, kind, tenantId, id);
  if (!row) return { refused: 'missing' };
  if (!close.from.includes(row.status)) return { refused: 'status', status: row.status };
  const closed = { ...row, status: 'closed', closedAt: close.at };
  const metadata = { [ID_KEY[kind]]: id };
  appendAudit(t, [{ tenantId, actor: close.actor, op: closeOp(kind), targetId: String(id), metadata }]);
  tableOf(t, kind).set(id, closed);
  return structuredClone(closed);
}

function inForceIn(t: MemoryTables, tenantId: string, query: PoliciesInForceQuery): Policy[] {
  const { asOf } = query;
  const replacedLater = (id: number | null): boolean => {
    const successor = id === null ? undefined : t.objects.policy.get(id);
    return successor !== undefined && byBytes(successor.validFrom, asOf) > 0;
  };
  const hits = [...t.objects.policy.values()].filter(
    (p) =>
      p.tenantId === tenantId &&
      p.status !== 'closed' &&
      (query.name === undefined || p.policyName === query.name) &&
      byBytes(p.validFrom, asOf) <= 0 &&
      (p.validTo === null || byBytes(asOf, p.validTo) < 0) &&
      (p.status === 'active' || replacedLater(p.supersededBy)),
  );
  return structuredClone(hits.sort(newestFirst({ key: (p) => p.validFrom, intId: (p) => p.id })).slice(0, query.limit));
}

function receiptsIn(t: MemoryTables, tenantId: string, tag: string, limit: number): BriefReceipt[] {
  const quoted = asciiFolded(`"${tag}"`);
  const hits = [...t.entries.values()].filter(
    (m) =>
      m.tenantId === tenantId &&
      m.source !== 'project_brief' &&
      passesScopeFilterForRecall(m.scope ?? null, undefined) &&
      asciiFolded(JSON.stringify(m.tags)).includes(quoted),
  );
  hits.sort(newestFirst({ key: (m) => m.created, textId: (m) => m.id }));
  return hits.slice(0, limit).map((m) => ({ id: m.id, created: m.created, source: m.source, content: m.content }));
}

function resolveIn(
  t: MemoryTables,
  tenantId: string,
  id: number,
  resolve: { text: string; actor: string; at: string },
) {
  const row = owned(t, 'incident', tenantId, id);
  if (!row) return { refused: 'missing' } as const;
  if (row.status !== 'open') return { refused: 'status', status: row.status } as const;
  const resolved: Incident = { ...row, status: 'resolved', resolutionText: resolve.text, resolvedAt: resolve.at };
  const metadata = { incident_id: id };
  appendAudit(t, [{ tenantId, actor: resolve.actor, op: 'incident_resolve', targetId: String(id), metadata }]);
  t.objects.incident.set(id, resolved);
  return structuredClone(resolved);
}

export function memoryObjects(t: MemoryTables): Objects {
  return {
    listObjects: async (tenantId, kind, query) => listIn(t, tenantId, kind, query),
    objectById: async (tenantId, kind, id) => structuredClone(owned(t, kind, tenantId, id) ?? null),
    closeObject: async (tenantId, kind, id, close) => closeIn(t, tenantId, kind, id, close),
    saveObject: async (tenantId, kind, save) => saveIn(t, tenantId, kind, save),
    openIncident: async (tenantId, open) => openIn(t, tenantId, open),
    resolveIncident: async (tenantId, id, resolve) => resolveIn(t, tenantId, id, resolve),
    policiesInForce: async (tenantId, query) => inForceIn(t, tenantId, query),
    activeSkillsByName: async (tenantId, limit) => {
      const hits = [...t.objects.skill.values()].filter((s) => s.tenantId === tenantId && s.status === 'active');
      return structuredClone(hits.sort((a, b) => byBytes(a.skillName, b.skillName) || a.id - b.id).slice(0, limit));
    },
    briefReceipts: async (tenantId, tag, limit) => receiptsIn(t, tenantId, tag, limit),
    async objectIdByMemory(tenantId, kind, status, memoryId) {
      const hits = [...tableOf(t, kind).values()].filter(
        (r) => r.tenantId === tenantId && r.status === status && r.memoryId === memoryId,
      );
      return hits.reduce<number | null>((best, r) => (best === null || r.id > best ? r.id : best), null);
    },
  };
}
