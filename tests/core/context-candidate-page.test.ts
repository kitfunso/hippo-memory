// A no-query contextGet reads a page of the strongest rows sized from its budget, not the 2000 rows the cap allows.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync } from 'node:fs';
import { contextGet } from '../../src/api/index.js';
import { closeHippoDb, getHippoDbPath, openHippoDb } from '../../src/db/index.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { peakRowsRead, recordStatementsAsync } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initTestStore } from '../_helpers/store-template.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const ROWS = 2300;
const DAY_MS = 86_400_000;
/** The statement that returns the candidate rows: the decay-key subset, or the ranked scan beneath it. */
const CANDIDATE_READ = /WITH top AS MATERIALIZED|ORDER BY pinned DESC/;
let seeded: string;
let ids: string[];
let root: string;

// Row i is i days old with one half-life for all, so strength order is recency order and the page holds the newest.
function seed(): string[] {
  const db = openHippoDb(seeded);
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

// Seeded once, outside any request, so its close checkpoints the WAL into hippo.db before a test copies it.
beforeAll(() => {
  seeded = makeRoot('ctx-page-seed');
  ids = seed();
});

beforeEach(() => {
  vi.stubEnv('HIPPO_HOME', undefined);
  root = makeRoot('ctx-page', { init: false });
  copyFileSync(getHippoDbPath(seeded), getHippoDbPath(root));
  initTestStore(root);
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeAfterRequest(root);
});

describe('contextGet with no query', () => {
  it('reads a page far under the 2000-row cap and returns the strongest rows', async () => {
    const { result, reads } = await recordStatementsAsync(() =>
      contextGet(apiCtx(root), { currentProject: 'proj', budget: 300 }),
    );

    expect(peakRowsRead(reads, CANDIDATE_READ)).toBeLessThanOrEqual(200);
    expect(peakRowsRead(reads, CANDIDATE_READ)).toBeGreaterThan(0);
    const returned = result.entries.map((e) => e.entry.id);
    expect(returned.length).toBeGreaterThan(5);
    expect(returned).toEqual(ids.slice(0, returned.length));
  });

  it('pages a larger budget deeper, up to the cap', async () => {
    const small = await recordStatementsAsync(() => contextGet(apiCtx(root), { currentProject: 'proj', budget: 300 }));
    const large = await recordStatementsAsync(() =>
      contextGet(apiCtx(root), { currentProject: 'proj', budget: 20_000 }),
    );

    expect(peakRowsRead(large.reads, CANDIDATE_READ)).toBeGreaterThan(peakRowsRead(small.reads, CANDIDATE_READ));
    expect(peakRowsRead(large.reads, CANDIDATE_READ)).toBeLessThanOrEqual(2000);
  });
});
