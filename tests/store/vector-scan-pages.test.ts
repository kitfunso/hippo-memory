// The nearest-vector scan reads the admitted vectors a page at a time and keeps the best k in a heap: its answer is a
// full sort's, ties across a page edge included, and no one statement hands back more than a page.
import { afterEach, describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { decodeVector, topVectorMatches, type VectorMatch } from '../../src/db/vector-store.js';
import { countMatching, peakRowsRead, recordStatementsAsync } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { clusteredVectors, near, SCAN_PAGE_ROWS, seedVectorRows, type VectorRowSeed } from '../_helpers/vector-rows.js';

const DIM = 8;
const SCAN = 'FROM memory_vectors v CROSS JOIN memories m';
const IN_T1 = { where: ' AND m.tenant_id = ?', params: ['t1'] };

const opened: DatabaseSyncLike[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeHippoDb(db);
});

interface ScanStore {
  readonly db: DatabaseSyncLike;
  /** The vector every seventh t1 row holds. */
  readonly twin: number[];
}

// Every seventh row of t1 repeats one vector, so equal scores straddle each page edge and the id decides them.
function seeded(t1Rows: number): ScanStore {
  const vectors = clusteredVectors(t1Rows + 300, DIM, 5);
  const twin = vectors[0];
  const rows: VectorRowSeed[] = vectors.map((vector, i) => ({
    id: `m${String(i).padStart(5, '0')}`,
    tenantId: i < t1Rows ? 't1' : 't2',
    vector: i < t1Rows && i % 7 === 0 ? twin : vector,
  }));
  const root = makeRoot('vector-scan-pages');
  seedVectorRows(root, rows);
  const db = openHippoDb(root);
  opened.push(db);
  return { db, twin };
}

/** Every admitted t1 vector scored as the scan scores one, sorted whole: higher score first, then the smaller id. */
function fullSort(db: DatabaseSyncLike, query: readonly number[], k: number): VectorMatch[] {
  const q = Float32Array.from(query);
  const qNorm = Math.sqrt(q.reduce((sum, x) => sum + x * x, 0));
  // SAFETY: node:sqlite returns BLOBs as Uint8Array.
  const rows = db
    .prepare(
      "SELECT v.memory_id AS id, v.vector AS vector FROM memory_vectors v JOIN memories m ON m.id = v.memory_id WHERE m.tenant_id = 't1'",
    )
    .all() as Array<{ id: string; vector: Uint8Array }>;
  const scored = rows.map(({ id, vector }) => {
    const v = decodeVector(vector);
    let dot = 0;
    let norm = 0;
    for (let i = 0; i < v.length; i++) {
      dot += q[i] * v[i];
      norm += v[i] * v[i];
    }
    return { id, score: dot / (qNorm * Math.sqrt(norm)) };
  });
  return scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, k);
}

describe('the paged nearest-vector scan', () => {
  it.each([1, 50, 400])('keeps the full sort top %i over two and a half pages, ties included', async (k) => {
    const { db, twin } = seeded(Math.floor(SCAN_PAGE_ROWS * 2.5));
    for (const query of [twin, near(twin, 3), near(twin, 4)]) {
      expect(await topVectorMatches(db, { query, k, ...IN_T1 })).toEqual(fullSort(db, query, k));
    }
  });

  it('answers every admitted row, best first, when k is more than the store holds', async () => {
    const { db, twin } = seeded(SCAN_PAGE_ROWS + 10);
    const all = await topVectorMatches(db, { query: twin, k: 5_000, ...IN_T1 });
    expect(all).toHaveLength(SCAN_PAGE_ROWS + 10);
    expect(all).toEqual(fullSort(db, twin, 5_000));
  });

  it('reads one page per statement, and one statement more per page of admitted rows', async () => {
    const t1Rows = Math.floor(SCAN_PAGE_ROWS * 2.5);
    const { db, twin } = seeded(t1Rows);
    const { statements, reads } = await recordStatementsAsync(() =>
      topVectorMatches(db, { query: twin, k: 50, ...IN_T1 }),
    );
    expect(countMatching(statements, SCAN)).toBe(Math.ceil(t1Rows / SCAN_PAGE_ROWS));
    expect(peakRowsRead(reads, SCAN)).toBe(SCAN_PAGE_ROWS);
  });
});
