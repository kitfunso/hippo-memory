// hippo.db's graphDelta plans the ops store/rules/graph-delta.ts diffGraph plans over every stored row of the tenant,
// and hands back only the rows that change.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { deriveGraph, extractGraph, loadGraphSources } from '../../src/domain/graph/extract.js';
import type {
  DesiredEntity,
  DesiredGraph,
  DesiredRelation,
  EntityType,
  GraphOp,
  NaturalKey,
  RelationType,
  SourceObjectRef,
  SourceObjectType,
} from '../../src/store/port/graph.js';
import {
  diffGraph,
  memoryIdsOf,
  type StoredEntity,
  type StoredGraph,
  type StoredRelation,
} from '../../src/store/rules/graph-delta.js';
import { insertEntityRow, insertRelationRow } from '../../src/store/sqlite/graph-writes.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { countMatching, peakRowsRead, recordStatementsAsync } from '../_helpers/count-statements.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeStore } from '../_helpers/make-root.js';
import { objectsAt } from '../_helpers/objects-at.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';

const T = 'default';
const OTHER = 'acme';
const NOW = '2026-10-01T00:00:00.000Z';
const ENTITY_TYPES: readonly EntityType[] = ['person', 'project', 'customer', 'system', 'policy', 'decision'];
const REL_TYPES: readonly RelationType[] = ['owns', 'supersedes', 'depends-on', 'blocked-by', 'references'];
// A pair cut in half is stored as U+FFFD and a padded name trimmed, so neither matches its desired twin.
const NAMES = ['Alpha', 'Beta', 'Gamma Ray', 'cut \uD83D', 'cut �', ' Padded '];
const DELTA_READ = 'json_each';

function withDb<R>(root: string, fn: (db: DatabaseSyncLike) => R): R {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <V>(r: () => number, items: readonly V[]): V => items[Math.floor(r() * items.length)]!;

function shuffled<V>(r: () => number, items: readonly V[]): V[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Decisions, policies and customer notes of one tenant, every fourth superseded. */
function seedObjects(db: DatabaseSyncLike, tenant: string, n: number): SourceObjectRef[] {
  const insert = {
    decision: `INSERT INTO decisions (tenant_id, decision_text, status, created_at) VALUES (?, 'd', ?, ?)`,
    policy: `INSERT INTO policies (tenant_id, policy_name, policy_text, valid_from, status, created_at)
      VALUES (?, 'p', 'p', '${NOW}', ?, ?)`,
    customer: `INSERT INTO customer_notes (tenant_id, customer, note, status, created_at) VALUES (?, 'c', 'c', ?, ?)`,
  } as const;
  return Array.from({ length: n }, (_, i) => {
    const type = (['decision', 'policy', 'customer'] as const)[i % 3]!;
    const run = db.prepare(insert[type]).run(tenant, i % 4 === 3 ? 'superseded' : 'active', NOW);
    return { type, id: Number(run.lastInsertRowid) };
  });
}

/** Entities on random keys, some loose and some sharing a key, and edges among them. */
function seedGraph(
  db: DatabaseSyncLike,
  tenant: string,
  r: () => number,
  objects: readonly SourceObjectRef[],
  memories: readonly string[],
): void {
  const ids = Array.from({ length: 40 }, () => {
    const anchored = r() < 0.85;
    return insertEntityRow(db, tenant, {
      entityType: pick(r, ENTITY_TYPES),
      name: pick(r, NAMES),
      memoryId: anchored && r() < 0.4 ? null : pick(r, memories),
      sourceObject: anchored ? pick(r, objects) : undefined,
    }).id;
  });
  const edges = Array.from({ length: 60 }, () => ({
    fromEntityId: pick(r, ids),
    toEntityId: pick(r, ids),
    relType: pick(r, REL_TYPES),
    memoryId: r() < 0.5 ? null : pick(r, memories),
    sourceObject: pick(r, objects),
  }));
  // Exact copies, so a key can hold two edges that both match the wanted one in full.
  for (const edge of [...edges, ...edges.filter(() => r() < 0.3)]) insertRelationRow(db, tenant, edge);
}

/** Every stored row of the tenant and the kind of each memory `desired` names: the read before graphDelta. */
function storedGraph(db: DatabaseSyncLike, tenant: string, desired: DesiredGraph): StoredGraph {
  // SAFETY: the SELECT names id and kind.
  const kinds = db
    .prepare(`SELECT id, kind FROM memories WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(memoryIdsOf(desired))) as Array<{ id: string; kind: string }>;
  // SAFETY: the SELECT names every StoredEntity column.
  const entities = db
    .prepare(
      `SELECT id, entity_type, name, memory_id, source_kind, source_object_type, source_object_id
       FROM entities WHERE tenant_id = ? ORDER BY id`,
    )
    .all(tenant) as StoredEntity[];
  // SAFETY: the SELECT names every StoredRelation column.
  const relations = db
    .prepare(
      `SELECT id, from_entity_id, to_entity_id, rel_type, memory_id, source_kind, source_object_type, source_object_id
       FROM relations WHERE tenant_id = ? ORDER BY id`,
    )
    .all(tenant) as StoredRelation[];
  return { kinds: new Map(kinds.map((k) => [k.id, k.kind])), entities, relations };
}

// SAFETY: the v38 CHECK constraints hold entity_type, rel_type and source_object_type to the port's enums.
const column = <E extends string>(value: string): E => value as E;

const keyOf = (row: StoredEntity): NaturalKey | null =>
  row.source_object_type === null || row.source_object_id === null
    ? null
    : {
        entityType: column<EntityType>(row.entity_type),
        sourceObject: { type: column<SourceObjectType>(row.source_object_type), id: row.source_object_id },
      };

/** A rebuild's desired graph: most stored keys again, some renamed or moved, new keys, twins and restated edges. */
function desiredGraph(
  r: () => number,
  stored: StoredGraph,
  objects: readonly SourceObjectRef[],
  memories: readonly (string | null)[],
): DesiredGraph {
  const storedKeys = stored.entities.map(keyOf);
  const reused = stored.entities.flatMap((row, i): DesiredEntity[] => {
    const key = storedKeys[i];
    if (!key || r() < 0.3) return [];
    return [
      {
        ...key,
        name: r() < 0.6 ? row.name : pick(r, NAMES),
        memoryId: r() < 0.6 ? row.memory_id : pick(r, memories),
      },
    ];
  });
  const fresh = Array.from({ length: 8 }, (): DesiredEntity => ({
    entityType: pick(r, ENTITY_TYPES),
    sourceObject: pick(r, objects),
    name: pick(r, NAMES),
    memoryId: pick(r, memories),
  }));
  const entities = [...reused, ...fresh];
  const twins = entities.filter(() => r() < 0.1).map((e) => ({ ...e, name: 'Later twin' }));
  const ends: NaturalKey[] = [...entities, ...storedKeys.filter((k): k is NaturalKey => k !== null)];
  const restated = stored.relations.flatMap((row): DesiredRelation[] => {
    const from = keyOf(stored.entities.find((e) => e.id === row.from_entity_id)!);
    const to = keyOf(stored.entities.find((e) => e.id === row.to_entity_id)!);
    if (!from || !to || row.source_object_type === null || r() < 0.4) return [];
    return [
      {
        from,
        to,
        relType: column<RelationType>(row.rel_type),
        memoryId: r() < 0.8 ? row.memory_id : pick(r, memories),
        sourceObject: { type: column<SourceObjectType>(row.source_object_type), id: row.source_object_id! },
      },
    ];
  });
  const made = Array.from({ length: 25 }, (): DesiredRelation => ({
    from: pick(r, ends),
    to: pick(r, ends),
    relType: pick(r, REL_TYPES),
    memoryId: pick(r, memories),
    sourceObject: pick(r, objects),
  }));
  return {
    entities: shuffled(r, [...entities, ...twins]),
    relations: shuffled(r, [...restated, ...made, ...restated.slice(0, 3).map((x) => ({ ...x, memoryId: null }))]),
  };
}

async function seedStore(seed: number) {
  const root = makeStore('graph-delta-sql').root;
  const r = random(seed);
  const memory = (id: string, tenantId: string, kind: 'distilled' | 'superseded' | 'raw') => ({
    ...createMemory(`memory ${id}`, { tenantId, kind }),
    id,
  });
  writeEntriesTogether(root, [
    memory('mem_d1', T, 'distilled'),
    memory('mem_d2', T, 'distilled'),
    memory('mem_s1', T, 'superseded'),
    memory('mem_raw', T, 'raw'),
    memory('mem_o1', OTHER, 'distilled'),
  ]);
  const objects = withDb(root, (db) => {
    const mine = seedObjects(db, T, 12);
    const theirs = seedObjects(db, OTHER, 6);
    seedGraph(db, T, r, mine, ['mem_d1', 'mem_d2', 'mem_s1']);
    seedGraph(db, OTHER, r, theirs, ['mem_o1']);
    return new Map([
      [T, mine],
      [OTHER, theirs],
    ]);
  });
  return { root, r, objects };
}

describe('graphDelta on hippo.db', () => {
  it('plans the ops diffGraph plans over every stored row, for 20 seeded stores in two tenants', async () => {
    const seen = new Set<GraphOp['op']>();
    let kept = 0;
    const memories = [null, 'mem_d1', 'mem_d2', 'mem_s1', 'mem_raw', 'mem_o1', 'mem_missing'];
    for (let seed = 1; seed <= 20; seed++) {
      const { root, r, objects } = await seedStore(seed);
      for (const tenant of [T, OTHER]) {
        const missing: SourceObjectRef = { type: 'project', id: 9999 };
        const desired = withDb(root, (db) =>
          desiredGraph(
            r,
            storedGraph(db, tenant, { entities: [], relations: [] }),
            [...objects.get(tenant)!, missing],
            memories,
          ),
        );
        const stored = withDb(root, (db) => storedGraph(db, tenant, desired));
        const expected = diffGraph(stored, desired);
        expect(await sqliteStore(root).graphReads.graphDelta(tenant, desired), `seed ${seed} ${tenant}`).toEqual(
          expected,
        );
        for (const op of expected) seen.add(op.op);
        kept += stored.entities.length - expected.filter((op) => op.op === 'deleteEntity').length;
      }
    }
    expect([...seen].sort()).toEqual([
      'deleteEntity',
      'deleteRelation',
      'insertEntity',
      'insertRelation',
      'updateEntity',
    ]);
    expect(kept).toBeGreaterThan(0);
  }, 300_000);
});

/** `n` policies and a decision naming each of the first tenth, so the graph holds entities and references edges. */
function seedPolicies(root: string, n: number): void {
  withDb(root, (db) => {
    db.prepare(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
       INSERT INTO policies (tenant_id, policy_name, policy_text, valid_from, created_at)
       SELECT ?, printf('Policy%05d', i), 'text', '${NOW}', '${NOW}' FROM k`,
    ).run(n, T);
    db.prepare(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
       INSERT INTO decisions (tenant_id, decision_text, created_at)
       SELECT ?, printf('we follow Policy%05d', i), '${NOW}' FROM k`,
    ).run(Math.max(1, n / 10), T);
  });
}

describe('graphDelta reads', () => {
  it.each([10, 1200])(
    'hands back no row for a stored graph of %i policies and one row for a rename',
    async (n) => {
      const root = makeStore('graph-delta-rows').root;
      seedPolicies(root, n);
      const store = sqliteStore(root);
      await extractGraph(store, T);
      const desired = deriveGraph(await loadGraphSources(objectsAt(root), T));
      expect(desired.relations.length).toBeGreaterThan(0);

      const steady = await recordStatementsAsync(() => store.graphReads.graphDelta(T, desired));
      expect(steady.result).toEqual([]);
      expect(countMatching(steady.statements, DELTA_READ)).toBe(2);
      expect(peakRowsRead(steady.reads, DELTA_READ)).toBe(0);

      withDb(root, (db) =>
        db.prepare(`UPDATE policies SET policy_name = 'Renamed' WHERE id = (SELECT max(id) FROM policies)`).run(),
      );
      const renamed = deriveGraph(await loadGraphSources(objectsAt(root), T));
      const one = await recordStatementsAsync(() => store.graphReads.graphDelta(T, renamed));
      expect(one.result.map((op) => op.op)).toEqual(['updateEntity']);
      expect(countMatching(one.statements, DELTA_READ)).toBe(2);
      expect(peakRowsRead(one.reads, DELTA_READ)).toBe(1);
    },
    300_000,
  );
});
