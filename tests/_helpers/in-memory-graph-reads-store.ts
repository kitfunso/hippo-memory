// A store other than hippo.db for the GraphReads group: it copies entities, relations and each memory's scope out of hippo.db once, then
// walks them in memory from the port's doc comments alone, so a conformance test shows those words are enough to build on.
import { vi } from 'vitest';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { savePolicy } from '../../src/objects/policies.js';
import { canReadScope } from '../../src/store/recall-scope.js';
import { withSqliteAllowed, type HippoStore } from '../../src/server.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { ENTITY_COLS, RELATION_COLS, rowToEntity, rowToRelation, type Entity, type EntityRow, type EntityType, type Relation, type RelationRow } from '../../src/store/graph-rows.js';
import { insertEntity, insertRelation } from '../../src/store/graph-writes.js';
import type { GraphReads, GraphRows, GraphViewQuery } from '../../src/store/port.js';
import { inMemoryKeyAuditStore } from './in-memory-key-audit-store.js';
import { TENANT_A, TENANT_B, type StoreSide } from './store-conformance.js';

export interface InMemoryGraphReadsStore extends StoreSide {
  readonly store: HippoStore & { readonly graphReads: GraphReads };
}

interface Copied {
  readonly entities: Entity[];
  readonly relations: Relation[];
  /** `tenant` then a NUL then the memory id, to that memory's scope. */
  readonly scopes: Map<string, string | null>;
}

const memoryKey = (tenantId: string, id: string): string => `${tenantId}\u0000${id}`;

function copyRows(hippoRoot: string): Copied {
  return withSqliteAllowed(() => {
    const db = openHippoDb(hippoRoot);
    try {
      // SAFETY: each SELECT names exactly the columns of the row type it is read as.
      const entities = (db.prepare(`SELECT ${ENTITY_COLS} FROM entities`).all() as EntityRow[]).map(rowToEntity);
      // SAFETY: as above.
      const relations = (db.prepare(`SELECT ${RELATION_COLS} FROM relations`).all() as RelationRow[]).map(rowToRelation);
      // SAFETY: as above.
      const memories = db.prepare('SELECT tenant_id, id, scope FROM memories').all() as { tenant_id: string; id: string; scope: string | null }[];
      return { entities, relations, scopes: new Map(memories.map((m) => [memoryKey(m.tenant_id, m.id), m.scope])) };
    } finally {
      closeHippoDb(db);
    }
  });
}

/** Byte order, as hippo.db compares text; JavaScript's own string order differs above the basic plane. */
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const newestFirst = (a: { createdAt: string; id: number }, b: { createdAt: string; id: number }): number => byBytes(b.createdAt, a.createdAt) || b.id - a.id;
const BATCH = 400;

function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
  return out;
}

/** The walk from a name, before any row is hidden; null when no start entity shows. */
function fromName(entities: Entity[], relations: Relation[], name: string, limit: number, shows: (row: Entity) => boolean): GraphRows | null {
  const named = entities.filter((e) => e.name === name).sort((a, b) => a.id - b.id).slice(0, limit);
  const startIds = named.filter(shows).map((e) => e.id);
  if (startIds.length === 0) return null;
  const joined: Relation[] = [];
  for (const batch of batches(startIds)) {
    const touching = relations.filter((r) => batch.includes(r.fromEntityId) || batch.includes(r.toEntityId)).sort(newestFirst).slice(0, limit);
    for (const r of touching) if (!joined.includes(r)) joined.push(r);
  }
  const held = new Set(startIds);
  let leftOver = false;
  for (const r of joined) {
    if (held.size >= limit) {
      leftOver = true;
      break;
    }
    held.add(r.fromEntityId).add(r.toEntityId);
  }
  const found = batches([...held]).flatMap((batch) => entities.filter((e) => batch.includes(e.id)).sort((a, b) => a.id - b.id));
  const among = relations.filter((r) => held.has(r.fromEntityId) && held.has(r.toEntityId)).sort(newestFirst).slice(0, limit);
  return { entities: found, relations: among, truncated: named.length >= limit || joined.length >= limit || among.length >= limit || leftOver };
}

function wholeGraph(entities: Entity[], relations: Relation[], limit: number): GraphRows {
  const newest = { entities: [...entities].sort(newestFirst).slice(0, limit), relations: [...relations].sort(newestFirst).slice(0, limit) };
  return { ...newest, truncated: newest.entities.length >= limit || newest.relations.length >= limit };
}

export function inMemoryGraphReadsStore(hippoRoot: string): InMemoryGraphReadsStore {
  const base = inMemoryKeyAuditStore(hippoRoot);
  const copied = copyRows(hippoRoot);
  const graphReads: GraphReads = {
    async graphRows(tenantId, { entity, limit, reader }: GraphViewQuery) {
      const shows = (row: { memoryId: string | null }): boolean => {
        if (row.memoryId === null || !reader) return true;
        const scope = copied.scopes.get(memoryKey(tenantId, row.memoryId));
        return scope !== undefined && (scope === null || canReadScope(reader, scope));
      };
      const entities = copied.entities.filter((e) => e.tenantId === tenantId);
      const relations = copied.relations.filter((r) => r.tenantId === tenantId);
      const rows = entity === undefined ? wholeGraph(entities, relations, limit) : fromName(entities, relations, entity, limit, shows);
      if (!rows) return { entities: [], relations: [], truncated: false };
      return structuredClone({ entities: rows.entities.filter(shows), relations: rows.relations.filter(shows), truncated: rows.truncated });
    },
  };
  return { store: { ...base.store, graphReads }, auditRows: base.auditRows };
}

const TEAM_SCOPE = null;
export const HELD_SCOPE = 'slack:private:Csecret';
export const ALICE_SCOPE = 'personal:private:alice';
export const SOLO_TENANT = 'solo';
export const BULK_TENANT = 'bulk';
/** One over a batch of 400 plus a few, so a walk from the name crosses a batch boundary. */
export const MANY = 405;
export const seededAt = (second: number): string => `2020-03-01T00:00:${String(second).padStart(2, '0')}.000Z`;

type InTenantA = 'hub' | 'spoke1' | 'spoke2' | 'secret' | 'mine' | 'twinHeld' | 'twinOpen' | 'lone' | 'shared' | 'anchored';
type Elsewhere = 'sharedB' | 'otherB' | 'solo' | 'tailA' | 'tailB';

/** Entity ids by a short name; `many` is the bulk tenant's same-named entities in id order. */
export interface SeededGraph {
  readonly e: Readonly<Record<InTenantA | Elsewhere, number>>;
  readonly many: readonly number[];
  /** Memory ids by the scope each sits under in tenant A. */
  readonly memories: Readonly<Record<'team' | 'held' | 'alice', string>>;
}

type Db = ReturnType<typeof openHippoDb>;

function seeder(db: Db, dir: string) {
  const memory = (tenantId: string, id: string, scope: string | null): string => {
    writeEntry(dir, { ...createMemory(`source of ${id}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId, scope }), id });
    return id;
  };
  const entity = (tenantId: string, second: number, name: string, entityType: EntityType, memoryId: string): number => {
    vi.setSystemTime(new Date(seededAt(second)));
    return insertEntity(dir, tenantId, { entityType, name, memoryId }, db).id;
  };
  const relation = (tenantId: string, second: number, fromEntityId: number, toEntityId: number, memoryId: string): number => {
    vi.setSystemTime(new Date(seededAt(second)));
    return insertRelation(dir, tenantId, { fromEntityId, toEntityId, relType: 'references', memoryId }, db).id;
  };
  return { memory, entity, relation };
}

interface SeededTenantA {
  readonly memories: SeededGraph['memories'];
  readonly e: Record<InTenantA, number>;
}

function seedTenantA(db: Db, dir: string, policyId: number): SeededTenantA {
  const { memory, entity, relation } = seeder(db, dir);
  const memories = { team: memory(TENANT_A, 'mem_gteam', TEAM_SCOPE), held: memory(TENANT_A, 'mem_gheld', HELD_SCOPE), alice: memory(TENANT_A, 'mem_galice', ALICE_SCOPE) };
  const hub = entity(TENANT_A, 1, 'Hub', 'project', memories.team);
  const spoke1 = entity(TENANT_A, 2, 'Spoke', 'system', memories.team);
  const spoke2 = entity(TENANT_A, 2, 'Spoke', 'project', memories.team);
  const secret = entity(TENANT_A, 3, 'Secret', 'customer', memories.held);
  const mine = entity(TENANT_A, 4, 'Mine', 'person', memories.alice);
  const twinHeld = entity(TENANT_A, 5, 'Twin', 'person', memories.held);
  const twinOpen = entity(TENANT_A, 5, 'Twin', 'person', memories.team);
  const lone = entity(TENANT_A, 6, 'Lone', 'decision', memories.team);
  const shared = entity(TENANT_A, 7, 'Shared', 'project', memories.team);
  // Stamped with the second `shared` left on the clock, so the two newest entities share a timestamp.
  const anchored = insertEntity(dir, TENANT_A, { entityType: 'policy', name: 'Anchored', memoryId: null, sourceObject: { type: 'policy', id: policyId } }, db).id;
  relation(TENANT_A, 8, hub, spoke1, memories.team);
  relation(TENANT_A, 8, hub, spoke2, memories.team);
  relation(TENANT_A, 9, spoke1, spoke2, memories.team);
  relation(TENANT_A, 10, hub, secret, memories.team);
  relation(TENANT_A, 11, secret, mine, memories.held);
  relation(TENANT_A, 12, shared, hub, memories.team);
  return { memories, e: { hub, spoke1, spoke2, secret, mine, twinHeld, twinOpen, lone, shared, anchored } };
}

/** Adds a graph to each of four tenants: A with rows under three scopes, B sharing one name with A, one entity under `solo`, and 405 same-named entities under `bulk`. */
export function seedGraphRows(dir: string): SeededGraph {
  const policyId = savePolicy(dir, TENANT_A, { policyName: 'Anchored', policyText: 'kept by its object' }).id;
  const db = openHippoDb(dir);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const a = seedTenantA(db, dir, policyId);
    const { memory, entity, relation } = seeder(db, dir);
    const memB = memory(TENANT_B, 'mem_gb', TEAM_SCOPE);
    const sharedB = entity(TENANT_B, 1, 'Shared', 'project', memB);
    const otherB = entity(TENANT_B, 2, 'Other', 'system', memB);
    relation(TENANT_B, 3, sharedB, otherB, memB);
    const solo = entity(SOLO_TENANT, 1, 'Only', 'project', memory(SOLO_TENANT, 'mem_gsolo', TEAM_SCOPE));
    const memBulk = memory(BULK_TENANT, 'mem_gbulk', TEAM_SCOPE);
    const tailA = entity(BULK_TENANT, 1, 'TailA', 'system', memBulk);
    const tailB = entity(BULK_TENANT, 1, 'TailB', 'system', memBulk);
    const many = Array.from({ length: MANY }, () => entity(BULK_TENANT, 2, 'Many', 'project', memBulk));
    // The older relation hangs off the first batch of 400 and the newer off the second.
    relation(BULK_TENANT, 3, many[0]!, tailA, memBulk);
    relation(BULK_TENANT, 4, many[MANY - 1]!, tailB, memBulk);
    return { memories: a.memories, e: { ...a.e, sharedB, otherB, solo, tailA, tailB }, many };
  } finally {
    vi.useRealTimers();
    closeHippoDb(db);
  }
}
