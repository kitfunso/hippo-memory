// When the v60 decay-key subset cannot prove its rank, loadContextCandidates ranks the tenant in one scan. It hands back
// the cap and no more, in the same three statements, whatever the store's size.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { countMatching, peakRowsRead, recordStatements } from '../_helpers/count-statements.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadContextCandidates } from '../_helpers/root-forms.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1);
const CAP = 5;
const HALF_LIVES = [3, 7, 30];
const COUNT = /^SELECT COUNT\(\*\) AS n FROM \(SELECT 1 FROM memories/;
const SUBSET = /WITH top AS MATERIALIZED/;
const SCAN = /ORDER BY pinned DESC,\s+CASE WHEN/;

/** Days since row `i` was last retrieved: two fresh rows, and the rest past two half-lives, so the subset is short. */
const ageOf = (i: number): number => (i < 2 ? 1 : 100 + (i % 97));

function seed(n: number): string {
  const home = makeRoot('context-fallback');
  const db = openHippoDb(home);
  try {
    db.exec('BEGIN');
    for (let i = 0; i < n; i++) {
      writeEntryDbOnly(db, {
        ...createMemory(`old row ${i}`, { tenantId: 'default' }),
        id: `m${String(i).padStart(5, '0')}`,
        created: new Date(NOW - (n - i) * 60_000).toISOString(),
        lastRetrieved: new Date(NOW - ageOf(i) * DAY).toISOString(),
        halfLifeDays: HALF_LIVES[i % 3]!,
      });
    }
    db.exec('COMMIT');
  } finally {
    closeHippoDb(db);
  }
  return home;
}

/** The rank worked out in JavaScript: least decayed first, ties on id, the cap kept, then in created order. */
function ranked(n: number): string[] {
  const rows = Array.from({ length: n }, (_, i) => ({ i, decay: ageOf(i) / HALF_LIVES[i % 3]! }));
  const best = rows.sort((a, b) => a.decay - b.decay || a.i - b.i).slice(0, CAP);
  return best.sort((a, b) => a.i - b.i).map((r) => `m${String(r.i).padStart(5, '0')}`);
}

describe('loadContextCandidates scan fallback', () => {
  // Seeds up to 10,000 real rows, and a runner's disk sets how long that takes.
  it.each([1000, 10_000])('ranks %i rows in one scan that hands back the cap', (n) => {
    const home = seed(n);
    const { result, statements, reads } = recordStatements(() =>
      loadContextCandidates(home, 'default', { cap: CAP, now: new Date(NOW) }),
    );
    expect(result.map((e) => e.id)).toEqual(ranked(n));
    expect([COUNT, SUBSET, SCAN].map((p) => countMatching(statements, p))).toEqual([1, 1, 1]);
    expect([COUNT, SUBSET, SCAN].map((p) => peakRowsRead(reads, p))).toEqual([1, 0, CAP]);
  }, 60_000);
});
