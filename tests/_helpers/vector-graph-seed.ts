// Seeded clustered vectors written through the store, for the vector graph tests.
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { batchWriteAndDelete } from '../../src/store/delete-and-batch.js';
import { saveStoredVectors } from '../../src/store/vector-index.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { topVectorMatches, type VectorMatch } from '../../src/db/vector-store.js';

export const DIM = 16;
export const MODEL = 'test-model';

/** mulberry32, so every run seeds the same vectors. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` vectors around `count / 50` centres. */
export function clusteredVectors(count: number, seed: number): number[][] {
  const r = seededRandom(seed);
  const centres = Array.from({ length: Math.max(1, Math.floor(count / 50)) }, () =>
    Array.from({ length: DIM }, () => r() * 2 - 1));
  return Array.from({ length: count }, (_, i) => centres[i % centres.length].map((x) => x + (r() - 0.5) * 0.4));
}

/** Writes one memory per vector (scope from `scopeOf`), then the vectors through the store; returns the ids in order. */
export function seedVectors(
  root: string,
  vectors: readonly number[][],
  scopeOf: (i: number) => string | null = () => null,
): string[] {
  const rows = vectors.map((_, i) =>
    createMemory(`note ${i}`, { tenantId: 'default', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, scope: scopeOf(i) }));
  batchWriteAndDelete(root, rows, []);
  saveStoredVectors(root, rows.map((r, i): [string, number[]] => [r.id, vectors[i]]), MODEL);
  return rows.map((r) => r.id);
}

export function withDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

export async function nearest(
  root: string,
  query: readonly number[],
  k: number,
  opts: { where?: string; minGraphRows?: number; ef?: number } = {},
): Promise<VectorMatch[]> {
  const db = openHippoDb(root);
  try {
    return await topVectorMatches(db, query, k, opts.where ?? '', [], opts);
  } finally {
    closeHippoDb(db);
  }
}
