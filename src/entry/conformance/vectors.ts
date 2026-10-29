// The vector checks: the backfill read, vector writes and the index's model, stored vectors and
// the nearest-row read.
import { ALL_TENANTS } from '../../base/util/tenant.js';
import type { HippoStore } from '../../base/ports/store-index.js';
import { TENANT, idsOf, rowOf, writeRows, type Check } from './kit.js';

const MODEL = 'conformance-model';

function writeVectors(store: HippoStore, rows: readonly [string, number[]][], model = MODEL) {
  return store.vectorWrites.writeVectors({
    tenantId: TENANT,
    model,
    replaceIndex: false,
    rows: rows.map(([memoryId, vector]) => ({ memoryId, vector })),
  });
}

const offices = () =>
  [rowOf(TENANT, 'the north office', 1), rowOf(TENANT, 'the east office', 2)] as const;

const writesAndReads: Check = async (store, expect) => {
  const [north, east] = offices();
  await writeRows(store, [north, east]);
  expect(await store.vectors.embeddingIndexState()).toEqual({
    storedModel: null,
    hasVectors: false,
  });
  const pending = async () =>
    idsOf(
      await store.vectorWrites.entriesWithoutVector({
        model: MODEL,
        limit: 10,
        tenantId: ALL_TENANTS,
      }),
    );
  expect(await pending()).toEqual([north.id, east.id].sort());
  expect(await writeVectors(store, [[north.id, [1, 0, 0]]])).toEqual({
    written: 1,
    modelMismatch: false,
  });
  expect(await pending()).toEqual([east.id]);
  expect(await store.vectors.embeddingIndexState()).toEqual({
    storedModel: MODEL,
    hasVectors: true,
  });
  const stored = await store.vectors.stored('vectors', [north.id, east.id]);
  expect([...stored.keys()]).toEqual([north.id]);
  expect(Array.from(stored.get(north.id) ?? [])).toEqual([1, 0, 0]);
  expect((await store.vectors.stored('vectors', [])).size).toBe(0);
};

const refusesOtherModel: Check = async (store, expect) => {
  const [north] = offices();
  await writeRows(store, [north]);
  await writeVectors(store, [[north.id, [1, 0, 0]]]);
  expect(await writeVectors(store, [[north.id, [0, 1, 0]]], 'other-model')).toEqual({
    written: 0,
    modelMismatch: true,
  });
};

const readsNearest: Check = async (store, expect) => {
  const [north, east] = offices();
  await writeRows(store, [north, east]);
  await writeVectors(store, [
    [north.id, [1, 0, 0]],
    [east.id, [0.6, 0.8, 0]],
  ]);
  const nearest = await store.vectors.nearestEntries([0, 1, 0], {
    tenantId: TENANT,
    includeSuperseded: false,
  });
  expect(idsOf(nearest)).toEqual([east.id, north.id]);
  const elsewhere = await store.vectors.nearestEntries([0, 1, 0], {
    tenantId: 'nobody',
    includeSuperseded: false,
  });
  expect(elsewhere).toEqual([]);
};

const namesOneIndex: Check = async (store, expect) => {
  const key = await store.vectorWrites.indexKey();
  expect(key.length > 0).toBe(true);
  expect(await store.vectorWrites.indexKey()).toBe(key);
};

export const VECTOR_CHECKS = {
  'lists rows without a vector, keeps written vectors under their model and reads them back':
    writesAndReads,
  "refuses another model's vectors unless the write replaces the index": refusesOtherModel,
  "answers the rows nearest a vector, nearest first, in the tenant's reach": readsNearest,
  'names one key for the index its writes land in': namesOneIndex,
} satisfies Readonly<Record<string, Check>>;
