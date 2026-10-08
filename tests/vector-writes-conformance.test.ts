// VectorWrites answers alike on hippo.db and on a store held in memory: the same values, the same errors and no audit rows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb, setMeta } from '../src/db.js';
import { embeddingIndexIdentity } from '../src/embeddings.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../src/memory.js';
import { initializeParticle, savePhysicsState } from '../src/physics-state.js';
import type { EmbeddingIndexState, PhysicsParticle, VectorBackfillQuery, VectorRowWrite, VectorWriteResult } from '../src/server.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors } from '../src/vector-store.js';
import { inMemoryVectorWritesStore } from './_helpers/in-memory-vector-writes-store.js';
import {
  onBothStores, seedTwoTenants, TENANT_A, TENANT_B, type GroupCall, type SideResult, type TwoTenantFixture,
} from './_helpers/store-conformance.js';

const MODEL = embeddingIndexIdentity('test:vec-3');
const OLD = embeddingIndexIdentity('test:old-3');
const NEW = embeddingIndexIdentity('test:new-3');
const SEEDED_AT = new Date('2026-02-01T00:00:00.000Z');
const ALL_IDS = ['mem_1', 'mem_2', 'mem_3', 'mem_4', 'mem_5', 'mem_6'];

type Value = MemoryEntry[] | VectorWriteResult | EmbeddingIndexState | [string, number[]][] | [string, PhysicsParticle][];
type Call = GroupCall<'vectorWrites', Value>;
type Side = SideResult<Value>;

let fixture: TwoTenantFixture;
let baseline: Side;
const entries = new Map<string, MemoryEntry>();

function memory(id: string, tenantId: string, day: number, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const created = `2026-01-0${day}T00:00:00.000Z`;
  return { ...createMemory(`vector conformance row ${id}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId }), id, created, last_retrieved: created, strength: 1, ...extra };
}

/** Ids interleave the tenants in byte order: mem_1 has a vector and a particle, mem_3 a vector under OLD, mem_4 a vector in tenant B. */
function seedMemories(dir: string): void {
  const rows = [
    memory('mem_1', TENANT_A, 1), memory('mem_2', TENANT_B, 2), memory('mem_3', TENANT_A, 3),
    memory('mem_4', TENANT_B, 4), memory('mem_5', TENANT_A, 5, { kind: 'archived' }), memory('mem_6', TENANT_A, 6),
  ];
  for (const row of rows) {
    writeEntry(dir, row);
    entries.set(row.id, row);
  }
  const db = openHippoDb(dir);
  try {
    upsertVectors(db, [['mem_1', [1, 0, 0]], ['mem_4', [0, 0, 1]]], MODEL);
    upsertVectors(db, [['mem_3', [0, 1, 0]]], OLD);
    setMeta(db, EMBEDDING_MODEL_META_KEY, MODEL);
    savePhysicsState(db, [initializeParticle(rows[0], [1, 0, 0], SEEDED_AT)]);
  } finally {
    closeHippoDb(db);
  }
}

async function conforms(calls: readonly Call[]): Promise<Side> {
  const sides = await onBothStores(fixture, 'vectorWrites', inMemoryVectorWritesStore, calls);
  expect(sides.other).toEqual(sides.sqlite);
  return sides.sqlite;
}

const missing = (query: VectorBackfillQuery): Call => (g) => g.entriesWithoutVector(query);
const write = (tenantId: string, model: string, rows: readonly VectorRowWrite[], replaceIndex = false): Call => (g) => g.writeVectors({ tenantId, model, replaceIndex, rows });
const indexState: Call = async (_g, store) => (await store.vectors?.embeddingIndexState()) ?? { storedModel: 'no vectors group', hasVectors: false };
const sorted = <V>(map: Map<string, V> | undefined): [string, V][] => [...(map ?? new Map<string, V>())].sort(([a], [b]) => (a < b ? -1 : 1));
const stored: Call = async (_g, store) => sorted(await store.vectors?.storedVectors(ALL_IDS));
const particles: Call = async (_g, store) => sorted(await store.vectors?.physicsParticles(ALL_IDS));
const particleFor = (id: string, vector: number[]): PhysicsParticle => initializeParticle(entries.get(id) ?? memory(id, TENANT_A, 9), vector, SEEDED_AT);

type Row = MemoryEntry | [string, number[]] | [string, PhysicsParticle];
const isEntry = (row: Row): row is MemoryEntry => !Array.isArray(row);

function idsOf(outcome: Side['outcomes'][number] | undefined): string[] {
  if (outcome === undefined || !('value' in outcome) || !Array.isArray(outcome.value)) throw new Error(`not a row list: ${JSON.stringify(outcome)}`);
  const rows: readonly Row[] = outcome.value;
  return rows.filter(isEntry).map((e) => e.id);
}

beforeAll(async () => {
  fixture = seedTwoTenants();
  seedMemories(fixture.dir);
  baseline = await conforms([indexState, stored, particles]);
});

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
});

it("starts from the seeded index: the model, three vectors and mem_1's particle", () => {
  expect(baseline.outcomes).toEqual([
    { value: { storedModel: MODEL, hasVectors: true } },
    { value: [['mem_1', [1, 0, 0]], ['mem_3', [0, 1, 0]], ['mem_4', [0, 0, 1]]] },
    { value: [['mem_1', particleFor('mem_1', [1, 0, 0])]] },
  ]);
});

describe('VectorWrites.entriesWithoutVector', () => {
  it("lists every tenant's memories with no vector under the model, archived ones too, by id", async () => {
    const side = await conforms([missing({ model: MODEL, limit: 10 })]);
    expect(idsOf(side.outcomes[0])).toEqual(['mem_2', 'mem_3', 'mem_5', 'mem_6']);
    expect(side.audit).toEqual(baseline.audit);
  });

  it('reads one tenant only when asked', async () => {
    const side = await conforms([missing({ model: MODEL, limit: 10, tenantId: TENANT_A }), missing({ model: MODEL, limit: 10, tenantId: TENANT_B }), missing({ model: MODEL, limit: 10, tenantId: 'nobody' })]);
    expect(side.outcomes.map(idsOf)).toEqual([['mem_3', 'mem_5', 'mem_6'], ['mem_2'], []]);
  });

  it('pages after an id, and the pages join up', async () => {
    const side = await conforms([missing({ model: MODEL, limit: 2 }), missing({ model: MODEL, limit: 2, afterId: 'mem_3' }), missing({ model: MODEL, limit: 2, afterId: 'mem_6' })]);
    expect(side.outcomes.map(idsOf)).toEqual([['mem_2', 'mem_3'], ['mem_5', 'mem_6'], []]);
  });

  it("counts a vector under another model as missing, so a model change lists every memory but the other model's", async () => {
    const side = await conforms([missing({ model: OLD, limit: 10 })]);
    expect(idsOf(side.outcomes[0])).toEqual(['mem_1', 'mem_2', 'mem_4', 'mem_5', 'mem_6']);
  });

  it('clamps the limit and refuses a non-integer with the same RangeError', async () => {
    const side = await conforms([missing({ model: MODEL, limit: 0 }), missing({ model: MODEL, limit: 10_000 }), missing({ model: MODEL, limit: 2.5 })]);
    expect(side.outcomes.slice(0, 2).map(idsOf)).toEqual([['mem_2'], ['mem_2', 'mem_3', 'mem_5', 'mem_6']]);
    expect(side.outcomes[2]).toEqual({ error: 'RangeError: limit must be an integer' });
  });
});

describe('VectorWrites.writeVectors', () => {
  it("stores the tenant's own rows only, and skips empty and non-finite vectors", async () => {
    const side = await conforms([
      write(TENANT_A, MODEL, [
        { memoryId: 'mem_6', vector: [0.5, 0.5, 0] },
        { memoryId: 'mem_2', vector: [1, 1, 1] },
        { memoryId: 'mem_missing', vector: [1, 0, 0] },
        { memoryId: 'mem_5', vector: [] },
        { memoryId: 'mem_3', vector: [Number.NaN, 0, 0] },
      ]),
      missing({ model: MODEL, limit: 10 }),
      stored,
      write(TENANT_B, MODEL, [{ memoryId: 'mem_2', vector: [0, 1, 1] }]),
    ]);
    expect(side.outcomes[0]).toEqual({ value: { written: 1, modelMismatch: false } });
    expect(idsOf(side.outcomes[1])).toEqual(['mem_2', 'mem_3', 'mem_5']);
    expect(side.outcomes[2]).toEqual({ value: [['mem_1', [1, 0, 0]], ['mem_3', [0, 1, 0]], ['mem_4', [0, 0, 1]], ['mem_6', [0.5, 0.5, 0]]] });
    expect(side.outcomes[3]).toEqual({ value: { written: 1, modelMismatch: false } });
    expect(side.audit).toEqual(baseline.audit);
  });

  it('writes nothing, and drops nothing even with replaceIndex, when no row is writable', async () => {
    const side = await conforms([write(TENANT_B, NEW, [{ memoryId: 'mem_1', vector: [0, 1, 0] }], true), write(TENANT_A, MODEL, []), indexState, stored]);
    expect(side.outcomes.slice(0, 2)).toEqual([{ value: { written: 0, modelMismatch: false } }, { value: { written: 0, modelMismatch: false } }]);
    expect(side.outcomes.slice(2)).toEqual(baseline.outcomes.slice(0, 2));
  });

  it("keeps a memory's particle and adds one only where none exists", async () => {
    const side = await conforms([
      write(TENANT_A, MODEL, [
        { memoryId: 'mem_1', vector: [0, 1, 0], particle: particleFor('mem_1', [0, 1, 0]) },
        { memoryId: 'mem_6', vector: [0.25, 0.5, 1], particle: { ...particleFor('mem_6', [0.25, 0.5, 1]), memoryId: 'mem_4' } },
      ]),
      particles,
    ]);
    expect(side.outcomes[0]).toEqual({ value: { written: 2, modelMismatch: false } });
    expect(side.outcomes[1]).toEqual({ value: [['mem_1', particleFor('mem_1', [1, 0, 0])], ['mem_6', particleFor('mem_6', [0.25, 0.5, 1])]] });
  });

  it("refuses a one-row write under another model without replaceIndex, leaving tenant B's vector, and drops every tenant's index with it", async () => {
    const row6 = { memoryId: 'mem_6', vector: [0, 1, 1], particle: particleFor('mem_6', [0, 1, 1]) };
    const side = await conforms([
      write(TENANT_A, NEW, [row6]),
      indexState,
      stored,
      particles,
      write(TENANT_A, NEW, [row6], true),
      write(TENANT_B, NEW, [{ memoryId: 'mem_2', vector: [1, 1, 0] }], true),
      indexState,
      stored,
      particles,
      missing({ model: NEW, limit: 10 }),
    ]);
    expect(side.outcomes.slice(0, 4)).toEqual([{ value: { written: 0, modelMismatch: true } }, ...baseline.outcomes]);
    expect(side.outcomes.slice(4, 8)).toEqual([
      { value: { written: 1, modelMismatch: false } },
      { value: { written: 1, modelMismatch: false } },
      { value: { storedModel: NEW, hasVectors: true } },
      { value: [['mem_2', [1, 1, 0]], ['mem_6', [0, 1, 1]]] },
    ]);
    expect(side.outcomes[8]).toEqual({ value: [['mem_6', particleFor('mem_6', [0, 1, 1])]] });
    expect(idsOf(side.outcomes[9])).toEqual(['mem_1', 'mem_3', 'mem_4', 'mem_5']);
    expect(side.audit).toEqual(baseline.audit);
  });
});
