// A no-query contextGet reads a page of the strongest rows sized from its budget, not the 2000 rows the cap allows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { contextGet } from '../../src/api/index.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { peakRowsRead, recordStatementsAsync } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';

const ROWS = 2300;
const DAY_MS = 86_400_000;
// Each case seeds 2300 rows in a real store, and a runner's disk sets how long that takes.
const SEED_MS = 30_000;
/** The statement that returns the candidate rows: the decay-key subset, or the ranked scan beneath it. */
const CANDIDATE_READ = /WITH top AS MATERIALIZED|ORDER BY pinned DESC/;
let root: string;

// Row i is i days old with one half-life for all, so strength order is recency order and the page holds the newest.
function seed(): string[] {
  const db = openHippoDb(root);
  const ids: string[] = [];
  try {
    db.exec('BEGIN');
    for (let i = 0; i < ROWS; i++) {
      const stamp = new Date(Date.now() - i * DAY_MS).toISOString();
      const entry = {
        ...createMemory(`note ${i}: a plain line about the build and the deploy`, { baseHalfLifeDays: 30 }),
        id: `m${String(i).padStart(4, '0')}`,
        created: stamp,
        lastRetrieved: stamp,
        originProject: 'proj',
      };
      writeEntryDbOnly(db, entry);
      ids.push(entry.id);
    }
    db.exec('COMMIT');
  } finally {
    closeHippoDb(db);
  }
  return ids;
}

beforeEach(() => {
  vi.stubEnv('HIPPO_HOME', undefined);
  root = makeRoot('ctx-page');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('contextGet with no query', () => {
  it('reads a page far under the 2000-row cap and returns the strongest rows', async () => {
    const ids = seed();
    const { result, reads } = await recordStatementsAsync(() =>
      contextGet(apiCtx(root), { currentProject: 'proj', budget: 300 }),
    );

    expect(peakRowsRead(reads, CANDIDATE_READ)).toBeLessThanOrEqual(200);
    expect(peakRowsRead(reads, CANDIDATE_READ)).toBeGreaterThan(0);
    const returned = result.entries.map((e) => e.entry.id);
    expect(returned.length).toBeGreaterThan(5);
    expect(returned).toEqual(ids.slice(0, returned.length));
  }, SEED_MS);

  it('pages a larger budget deeper, up to the cap', async () => {
    seed();
    const small = await recordStatementsAsync(() => contextGet(apiCtx(root), { currentProject: 'proj', budget: 300 }));
    const large = await recordStatementsAsync(() =>
      contextGet(apiCtx(root), { currentProject: 'proj', budget: 20_000 }),
    );

    expect(peakRowsRead(large.reads, CANDIDATE_READ)).toBeGreaterThan(peakRowsRead(small.reads, CANDIDATE_READ));
    expect(peakRowsRead(large.reads, CANDIDATE_READ)).toBeLessThanOrEqual(2000);
  }, SEED_MS);
});
