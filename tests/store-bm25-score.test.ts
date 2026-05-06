/**
 * F1 (v1.7.0) — `MemoryEntry.bm25_score` populated on the FTS path of
 * `loadSearchEntries` and `undefined` everywhere else.
 *
 * loadSearchRows in src/store.ts has FOUR query paths:
 *   1. No-terms path (empty query)            → no FTS, score undefined
 *   2. FTS path (terms + FTS available)        → bm25_score populated
 *   3. LIKE fallback (terms + FTS unavailable) → no FTS, score undefined
 *   4. Full-store fallback (LIKE returns 0)    → no FTS, score undefined
 *
 * Tests cover all four. The LIKE-fallback test forces
 * `fts5_available=0` via setMeta to reach the branch deterministically
 * (codex P2-2: don't rely on a "miss" to fall through).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, loadSearchEntries } from '../src/store.js';
import { createMemory, Layer, MemoryKind, type MemoryEntry } from '../src/memory.js';

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(root, '.hippo'), { recursive: true });
  initStore(root);
  return root;
}
function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function makeRaw(text: string): MemoryEntry {
  return createMemory(text, {
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw' as MemoryKind,
    tenantId: 'default',
  });
}

describe('loadSearchEntries bm25_score (F1, v1.7.0)', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('f1'); });
  afterEach(() => safeRmSync(root));

  it('FTS path: every returned entry has finite numeric bm25_score, sorted ascending (best first)', () => {
    writeEntry(root, makeRaw('alpha beta gamma delta epsilon'));
    writeEntry(root, makeRaw('alpha beta'));
    writeEntry(root, makeRaw('zeta eta theta'));
    const results = loadSearchEntries(root, 'alpha beta', 200, 'default');
    // FTS path returns rows that match the OR of terms; we expect at least
    // the two alpha rows but tolerate any matching set sized 1+.
    const matched = results.filter((e) => e.bm25_score !== undefined);
    expect(matched.length).toBeGreaterThanOrEqual(1);
    for (const e of matched) {
      expect(typeof e.bm25_score).toBe('number');
      expect(Number.isFinite(e.bm25_score!)).toBe(true);
    }
    // Ascending bm25_score (FTS5: lower = better).
    for (let i = 1; i < matched.length; i++) {
      expect(matched[i - 1]!.bm25_score!).toBeLessThanOrEqual(matched[i]!.bm25_score!);
    }
  });

  it('FTS path: two-term match scores LOWER (better) than one-term match', () => {
    writeEntry(root, makeRaw('alpha beta'));
    writeEntry(root, makeRaw('alpha by itself'));
    const results = loadSearchEntries(root, 'alpha beta', 200, 'default');
    const both = results.find((e) => e.content === 'alpha beta');
    const one = results.find((e) => e.content === 'alpha by itself');
    expect(both?.bm25_score).toBeDefined();
    expect(one?.bm25_score).toBeDefined();
    expect(both!.bm25_score!).toBeLessThan(one!.bm25_score!);
  });

  it('No-terms path: empty query returns entries with bm25_score undefined', () => {
    writeEntry(root, makeRaw('any content'));
    const results = loadSearchEntries(root, '', 200, 'default');
    expect(results.length).toBeGreaterThan(0);
    for (const e of results) {
      expect(e.bm25_score).toBeUndefined();
    }
  });

  it('No-terms path: honours the LIMIT parameter (self-review fix)', () => {
    // Self-review found the no-terms path was uncapped pre-v1.7.0 (codex
    // diff-pass only flagged the bottom-of-function full-store fallback).
    // Insert 50 raws, request limit=10, assert exactly 10 returned.
    for (let i = 0; i < 50; i++) writeEntry(root, makeRaw(`row ${i}`));
    const results = loadSearchEntries(root, '', 10, 'default');
    expect(results.length).toBe(10);
    for (const e of results) {
      expect(e.bm25_score).toBeUndefined();
    }
  });

  it('No-terms path: returns rows ordered by created ASC then id ASC, with stamped created surviving writeEntry (v1.7.1 INFO #3 + P1)', () => {
    // P1[5]: verify stamped `created` survives writeEntry → roundtrip read.
    // upsertEntryRow (store.ts:860) passes entry.created straight through;
    // a future normalizer would silently break this test. Anchor explicitly.
    const probe = makeRaw('roundtrip probe');
    probe.created = '2026-05-06T00:00:00.000Z';
    // codex P1[3]: stamp valid_from too — createMemory sets it to now() at
    // construction; without alignment, valid_from > created is illegal-state
    // bait for any future schema migration. Cheap future-proofing.
    probe.valid_from = probe.created;
    writeEntry(root, probe);
    const reread = loadSearchEntries(root, '', 1, 'default');
    expect(reread.length).toBe(1);
    expect(reread[0]!.created).toBe('2026-05-06T00:00:00.000Z');

    // Now the actual ORDER BY assertion: src/store.ts no-terms SQL is
    // `ORDER BY created ASC, id ASC LIMIT ?`. Existing test asserts row
    // count but not order. Pin chronological ordering.
    const created: string[] = [];
    for (let i = 0; i < 50; i++) {
      const e = makeRaw(`row-${i.toString().padStart(2, '0')}`);
      // Spaced 1s apart so byte-cmp ordering is unambiguous.
      e.created = new Date(Date.UTC(2026, 4, 6, 1, 0, i)).toISOString();
      created.push(e.created);
      writeEntry(root, e);
    }
    const results = loadSearchEntries(root, '', 10, 'default');
    expect(results.length).toBe(10);
    // Earliest 10 by created ASC: the 'roundtrip probe' at 00:00:00Z is first,
    // then rows 0-8 at 01:00:00Z through 01:00:08Z.
    const expectedOrder = ['2026-05-06T00:00:00.000Z', ...created.slice(0, 9)];
    const got = results.map((e) => e.created);
    expect(got).toEqual(expectedOrder);
  });

  it('LIKE fallback path: HIPPO_FORCE_LIKE_PATH=1 routes through LIKE deterministically; bm25_score undefined; expected row anchored (v1.7.1 senior P2.3 + INFO #7)', () => {
    // v1.7.0 used a substring "alphab" tokenizer-miss to route through LIKE
    // — fragile under porter/trigram tokenizers (senior P2.3). Both rev.1
    // alternatives (DROP TABLE, setMeta('fts5_available','0')) are no-ops
    // because ensureOptionalFts runs CREATE+backfill+meta-write on every
    // openHippoDb (db.ts:998-1029).
    //
    // v1.7.1 fix: HIPPO_FORCE_LIKE_PATH=1 is read at the start of
    // loadSearchRows so loadSearchRows skips the FTS branch unconditionally
    // and runs the LIKE query. Gated at the read site (NOT inside
    // isFtsAvailable) so writes (syncFtsRow, deleteFtsRow, raw-archive)
    // keep maintaining the FTS index honestly — no on-disk poisoning.
    //
    // INFO #7: anchor on the expected content so a partial hit cannot let
    // the test pass spuriously.
    const prevEnv = process.env.HIPPO_FORCE_LIKE_PATH;
    try {
      writeEntry(root, makeRaw('alphabet soup contents'));
      process.env.HIPPO_FORCE_LIKE_PATH = '1';
      const results = loadSearchEntries(root, 'alphabet', 200, 'default');
      expect(results.length).toBeGreaterThan(0);
      // Anchor: the expected row must come back via the LIKE branch.
      expect(results.some((e) => e.content === 'alphabet soup contents')).toBe(true);
      // No FTS path → no bm25_score on any returned row.
      for (const e of results) {
        expect(e.bm25_score).toBeUndefined();
      }
    } finally {
      if (prevEnv === undefined) delete process.env.HIPPO_FORCE_LIKE_PATH;
      else process.env.HIPPO_FORCE_LIKE_PATH = prevEnv;
    }
  });

  it('Full-store fallback path: terms with no match → no FTS hit, no LIKE hit → fallback returns all rows with bm25_score undefined', () => {
    writeEntry(root, makeRaw('one row'));
    writeEntry(root, makeRaw('another row'));
    // Use a very rare token combination that should miss FTS and LIKE both
    // (FTS will return 0 rows, LIKE will too, and the fallback returns
    // all tenant rows). Even if FTS returns a row, it'd score < 0 and
    // populate bm25_score; we explicitly assert undefined ONLY when no
    // FTS row was returned, then assert against the fallback.
    const results = loadSearchEntries(
      root,
      'zzzznonexistenttokenxxxxxx qqqqqqq',
      200,
      'default',
    );
    expect(results.length).toBeGreaterThan(0);
    // None of the returned rows should carry bm25_score because we did
    // not enter the FTS path (FTS returned 0 → fell through to LIKE → 0
    // → full-store fallback).
    for (const e of results) {
      expect(e.bm25_score).toBeUndefined();
    }
  });

  it('Full-store fallback path: honours LIMIT (regression for codex P1 — pre-v1.7.0 was uncapped)', () => {
    // Codex caught that the full-store fallback returned the entire tenant
    // store ignoring `limit`. Pre-v1.7.0 a query with no FTS hit and
    // limit=10 returned all 30 rows; the fix added LIMIT ?. This test
    // would FAIL on pre-v1.7.0 store.ts (returned 30) and PASSES on the
    // fix (returns exactly 10).
    for (let i = 0; i < 30; i++) writeEntry(root, makeRaw(`content ${i}`));
    const results = loadSearchEntries(
      root,
      'zzzznonexistenttokenxxxxxx qqqqqqq',
      10,
      'default',
    );
    expect(results.length).toBe(10);
    for (const e of results) {
      expect(e.bm25_score).toBeUndefined();
    }
  });
});
