// Memories with stored vectors, written in one transaction through the store's own row writers, and seeded vectors.
import { closeHippoDb, openHippoDb, setMeta } from '../../src/db/index.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors } from '../../src/db/vector-store.js';
import { writeEntryDbOnly } from '../../src/store/entry-writes.js';
import { createMemory } from './default-half-life-memory.js';

export interface VectorRowSeed {
  readonly id: string;
  readonly tenantId: string;
  readonly scope?: string;
  readonly vector: readonly number[];
}

/** mulberry32: the same seed gives the same numbers on every runner. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unit(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return v.map((x) => x / norm);
}

/** `n` unit vectors of length `dim` around n / 20 centres, as embeddings of related texts fall. */
export function clusteredVectors(n: number, dim: number, seed: number): number[][] {
  const r = seededRandom(seed);
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const centres = Array.from({ length: Math.max(1, Math.floor(n / 20)) }, () => unit(Array.from({ length: dim }, gauss)));
  return Array.from({ length: n }, (_, i) => unit(centres[i % centres.length].map((x) => x + gauss() * 0.5 / Math.sqrt(dim))));
}

/** `v` moved a little, as a query near a stored row is. */
export function near(v: readonly number[], seed: number): number[] {
  const r = seededRandom(seed);
  return unit(v.map((x) => x + (r() - 0.5) * 0.2 / Math.sqrt(v.length)));
}

export function seedVectorRows(root: string, rows: readonly VectorRowSeed[], model = 'test:vectors'): void {
  const db = openHippoDb(root);
  try {
    db.exec('BEGIN');
    for (const row of rows) {
      const entry = { ...createMemory(`memory ${row.id}`, { tenantId: row.tenantId, scope: row.scope ?? null }), id: row.id };
      writeEntryDbOnly(db, entry);
    }
    upsertVectors(db, rows.map((row): [string, readonly number[]] => [row.id, row.vector]), model);
    setMeta(db, EMBEDDING_MODEL_META_KEY, model);
    db.exec('COMMIT');
  } finally {
    closeHippoDb(db);
  }
}
