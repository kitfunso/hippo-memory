/**
 * F1 (v1.7.0): `MemoryEntry.bm25Score` populated on the FTS path of
 * `loadSearchEntries` and `undefined` everywhere else.
 *
 * loadSearchRows in src/store/search-rows.ts has FOUR query paths:
 *   1. No-terms path (empty query)            → no FTS, score undefined
 *   2. FTS path (terms + FTS available)        → bm25_score populated
 *   3. LIKE fallback (terms + FTS unavailable) → no FTS, score undefined
 *   4. Full-store fallback (LIKE returns 0)    → no FTS, score undefined
 *
 * Tests cover all four. The LIKE-fallback test forces
 * `fts5_available=0` via setMeta to reach the branch deterministically
 * (codex P2-2: don't rely on a "miss" to fall through).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { loadRecallEntries } from '../../src/store/sqlite/search-rows.js';
import { loadSearchEntries, writeEntry, writeEntriesTogether } from '../_helpers/root-forms.js';
import { closeHippoDb, openHippoDb, withSharedStoreHandles } from '../../src/db/index.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeRaw(text: string): MemoryEntry {
  return createMemory(text, {
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw',
    tenantId: 'default',
  });
}

describe('loadSearchEntries bm25_score', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('f1');
  });
  afterEach(() => removeAfterRequest(root));

  it('FTS path: every returned entry has finite numeric bm25_score, sorted ascending (best first)', () => {
    writeEntry(root, makeRaw('alpha beta gamma delta epsilon'));
    writeEntry(root, makeRaw('alpha beta'));
    writeEntry(root, makeRaw('zeta eta theta'));
    const results = loadSearchEntries(root, 'alpha beta', 200, 'default');
    // FTS path returns rows that match the OR of terms; we expect at least
    // the two alpha rows but tolerate any matching set sized 1+.
    const matched = results.filter((e) => e.bm25Score !== undefined);
    expect(matched.length).toBeGreaterThanOrEqual(1);
    for (const e of matched) {
      expect(e.bm25Score).toEqual(expect.any(Number));
      expect(Number.isFinite(e.bm25Score!)).toBe(true);
    }
    // Ascending bm25_score (FTS5: lower = better).
    for (let i = 1; i < matched.length; i++) {
      expect(matched[i - 1]!.bm25Score!).toBeLessThanOrEqual(matched[i]!.bm25Score!);
    }
  });

  it('FTS path: two-term match scores LOWER (better) than one-term match', () => {
    writeEntry(root, makeRaw('alpha beta'));
    writeEntry(root, makeRaw('alpha by itself'));
    const results = loadSearchEntries(root, 'alpha beta', 200, 'default');
    const both = results.find((e) => e.content === 'alpha beta');
    const one = results.find((e) => e.content === 'alpha by itself');
    expect(both?.bm25Score).toBeTypeOf('number');
    expect(one?.bm25Score).toBeTypeOf('number');
    expect(both!.bm25Score!).toBeLessThan(one!.bm25Score!);
  });

  it('No-terms path: empty query returns entries with bm25_score undefined', () => {
    writeEntry(root, makeRaw('any content'));
    const results = loadSearchEntries(root, '', 200, 'default');
    expect(results.map((e) => e.content)).toEqual(['any content']);
    for (const e of results) {
      expect(e.bm25Score).toBeUndefined();
    }
  });

  it('No-terms path: honours the LIMIT parameter', async () => {
    // Self-review found the no-terms path was uncapped pre-v1.7.0 (codex
    // diff-pass only flagged the bottom-of-function full-store fallback).
    // Insert 50 raws, request limit=10, assert exactly 10 returned.
    await withSharedStoreHandles(() => {
      for (let i = 0; i < 50; i++) writeEntry(root, makeRaw(`row ${i}`));
    });
    const results = loadSearchEntries(root, '', 10, 'default');
    expect(results.length).toBe(10);
    for (const e of results) {
      expect(e.bm25Score).toBeUndefined();
    }
  });

  it('No-terms path: returns rows ordered by created ASC then id ASC, with stamped created surviving writeEntry', async () => {
    // P1[5]: verify stamped `created` survives writeEntry → roundtrip read.
    // upsertEntryRow (store/entry-row.ts) passes entry.created straight through;
    // a future normalizer would silently break this test. Anchor explicitly.
    const probe = makeRaw('roundtrip probe');
    probe.created = '2026-05-06T00:00:00.000Z';
    // codex P1[3]: stamp valid_from too — createMemory sets it to now() at
    // construction; without alignment, valid_from > created is illegal-state
    // bait for any future schema migration. Cheap future-proofing.
    probe.validFrom = probe.created;
    writeEntry(root, probe);
    const reread = loadSearchEntries(root, '', 1, 'default');
    expect(reread.length).toBe(1);
    expect(reread[0]!.created).toBe('2026-05-06T00:00:00.000Z');

    // Now the actual ORDER BY assertion: src/store/search-rows.ts no-terms SQL is
    // `ORDER BY created ASC, id ASC LIMIT ?`. Existing test asserts row
    // count but not order. Pin chronological ordering.
    const created: string[] = [];
    await withSharedStoreHandles(() => {
      for (let i = 0; i < 50; i++) {
        const e = makeRaw(`row-${i.toString().padStart(2, '0')}`);
        // Spaced 1s apart so byte-cmp ordering is unambiguous.
        e.created = new Date(Date.UTC(2026, 4, 6, 1, 0, i)).toISOString();
        created.push(e.created);
        writeEntry(root, e);
      }
    });
    const results = loadSearchEntries(root, '', 10, 'default');
    expect(results.length).toBe(10);
    // Earliest 10 by created ASC: the 'roundtrip probe' at 00:00:00Z is first,
    // then rows 0-8 at 01:00:00Z through 01:00:08Z.
    const expectedOrder = ['2026-05-06T00:00:00.000Z', ...created.slice(0, 9)];
    const got = results.map((e) => e.created);
    expect(got).toEqual(expectedOrder);
  });

  it('LIKE fallback path: a part-word query reaches LIKE; bm25_score undefined; expected row anchored', () => {
    // FTS5 matches whole tokens, so a part-word is the only route to LIKE that leaves the FTS index untouched.
    writeEntry(root, makeRaw('alphabet soup contents'));
    const results = loadSearchEntries(root, 'alphab', 200, 'default');
    expect(results).toHaveLength(1);
    // Anchor: the expected row must come back via the LIKE branch.
    expect(results.some((e) => e.content === 'alphabet soup contents')).toBe(true);
    // No FTS path → no bm25_score on any returned row.
    for (const e of results) {
      expect(e.bm25Score).toBeUndefined();
    }
  });

  it('the environment cannot force the LIKE route: with the old variable set, a term query still comes back through FTS', () => {
    writeEntry(root, makeRaw('alphabet soup contents'));
    vi.stubEnv('HIPPO_FORCE_LIKE_PATH', '1');
    const results = loadSearchEntries(root, 'alphabet', 200, 'default');
    expect(results.map((e) => e.content)).toEqual(['alphabet soup contents']);
    expect(results[0]!.bm25Score).toEqual(expect.any(Number));
  });

  // Seeds 6,000 rows, in two transactions, since store size is the thing it varies.
  it('LIKE fallback path: a query matching nothing tests the same number of rows however large the store', () => {
    const db = openHippoDb(root);
    try {
      let lowered = 0;
      // SAFETY: node:sqlite's DatabaseSync has `function` at runtime; DatabaseSyncLike omits it because src registers none.
      (db as typeof db & { function(name: string, fn: (text: string) => string): void }).function('lower', (text) => {
        lowered++;
        return text.toLowerCase();
      });
      const rowsTested = [3000, 6000].map((size, step) => {
        db.exec('BEGIN');
        for (let i = step * 3000; i < size; i++) writeEntryDbOnly(db, makeRaw(`deploy note ${i}`));
        db.exec('COMMIT');
        lowered = 0;
        expect(loadRecallEntries(db, 'zzzznonexistenttokenxxxxxx', { limit: 200, tenantId: 'default' })).toHaveLength(
          200,
        );
        // The LIKE predicate lowers content and tags once per term for each row it tests.
        return lowered / 2;
      });
      // Both stores outgrow the 2,000-row window LIKE tests (LIKE_WINDOW_ROWS in src/store/search-rows.ts).
      expect(rowsTested[0]).toBe(2000);
      expect(rowsTested[1]).toBe(rowsTested[0]);
    } finally {
      closeHippoDb(db);
    }
  }, 30_000);

  it('Full-store fallback path: terms with no match → no FTS hit, no LIKE hit → fallback returns all rows with bm25_score undefined', () => {
    writeEntry(root, makeRaw('one row'));
    writeEntry(root, makeRaw('another row'));
    // Use a very rare token combination that should miss FTS and LIKE both
    // (FTS will return 0 rows, LIKE will too, and the fallback returns
    // all tenant rows). Even if FTS returns a row, it'd score < 0 and
    // populate bm25_score; we explicitly assert undefined ONLY when no
    // FTS row was returned, then assert against the fallback.
    const results = loadSearchEntries(root, 'zzzznonexistenttokenxxxxxx qqqqqqq', 200, 'default');
    expect(results.map((e) => e.content).sort()).toEqual(['another row', 'one row']);
    // None of the returned rows should carry bm25_score because we did
    // not enter the FTS path (FTS returned 0 → fell through to LIKE → 0
    // → full-store fallback).
    for (const e of results) {
      expect(e.bm25Score).toBeUndefined();
    }
  });

  it('Full-store fallback path: honours LIMIT (regression: it was once uncapped)', () => {
    // Codex caught that the full-store fallback returned the entire tenant
    // store ignoring `limit`. Pre-v1.7.0 a query with no FTS hit and
    // limit=10 returned all 30 rows; the fix added LIMIT ?. This test
    // would FAIL on pre-v1.7.0 store.ts (returned 30) and PASSES on the
    // fix (returns exactly 10).
    writeEntriesTogether(
      root,
      Array.from({ length: 30 }, (_, i) => makeRaw(`content ${i}`)),
    );
    const results = loadSearchEntries(root, 'zzzznonexistenttokenxxxxxx qqqqqqq', 10, 'default');
    expect(results.length).toBe(10);
    for (const e of results) {
      expect(e.bm25Score).toBeUndefined();
    }
  });
});
