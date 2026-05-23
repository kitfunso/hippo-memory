/**
 * F3 (v1.7.0) — `RecallOpts.scorerWindow` opt-in for the candidate pool
 * the scorer evaluates, separate from `limit` (results returned).
 *
 * Codex mk2-pass P0-1: defaulting `scorerWindow` to `limit` would have
 * shrunk the candidate pool and killed overflow summaries. The default
 * MUST preserve every pre-v1.7.0 caller's behaviour: candidates load
 * up to the store-internal default (200), `limit` slices the BM25-ranked
 * top-N, fresh-tail and summary substitution can extend the result count
 * above `limit`. F3 only adds an OPT-IN to widen the candidate pool.
 *
 * Codex mk2-pass P1-1: F3 does NOT introduce a hard cap. Existing API
 * shape preserved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, MemoryKind, type MemoryEntry } from '../src/memory.js';
import { recall, type Context } from '../src/api.js';

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(root, '.hippo'), { recursive: true });
  initStore(root);
  return root;
}
function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function ctxFor(root: string, tenantId: string = 'default'): Context {
  return { hippoRoot: root, tenantId, actor: { subject: 'test:f3', role: 'admin' } };
}
function makeRaw(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  return createMemory(text, {
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw' as MemoryKind,
    tenantId: opts.tenantId ?? 'default',
  });
}

describe('RecallOpts.scorerWindow (F3, v1.7.0)', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('f3'); });
  afterEach(() => safeRmSync(root));

  it('default (scorerWindow undefined): RecallResult.windowSize equals store default 200 — back-compat preserved', () => {
    writeEntry(root, makeRaw('alpha'));
    const result = recall(ctxFor(root), { query: 'alpha' });
    expect(result.windowSize).toBe(200);
  });

  it('explicit scorerWindow: RecallResult.windowSize equals the opt-in value', () => {
    writeEntry(root, makeRaw('alpha'));
    const result = recall(ctxFor(root), { query: 'alpha', scorerWindow: 50 });
    expect(result.windowSize).toBe(50);
  });

  it('scorerWindow can widen the candidate pool above limit (proves widening)', () => {
    // Codex diff-pass P2 #4: original assertion `total <= 25 && total > 0`
    // would pass even if the implementation accidentally loaded only
    // `limit` candidates. Strengthen: insert 30 raws all matching the
    // query, request scorerWindow: 25, assert total > limit AND
    // total === 25 (the FTS path under SQLite returns exactly LIMIT
    // matching rows when more than LIMIT exist).
    for (let i = 0; i < 30; i++) writeEntry(root, makeRaw(`zeta ${i}`));
    const result = recall(ctxFor(root), {
      query: 'zeta',
      limit: 5,
      scorerWindow: 25,
    });
    expect(result.windowSize).toBe(25);
    // Wider than limit — proves scorerWindow actually widened the pool.
    expect(result.total).toBeGreaterThan(5);
    // FTS5 + LIMIT 25 against a 30-row matching population returns 25.
    expect(result.total).toBe(25);
  });

  it('scorerWindow validation: 0 throws RecallContractError with invalid_scorer_window', () => {
    writeEntry(root, makeRaw('alpha'));
    let thrown: unknown = null;
    try {
      recall(ctxFor(root), { query: 'alpha', scorerWindow: 0 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    // Same RecallContractError class, distinguishable by code.
    expect((thrown as { name: string; code?: string }).name).toBe(
      'RecallContractError',
    );
    expect((thrown as { code?: string }).code).toBe('invalid_scorer_window');
  });

  it.each([-5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'scorerWindow=%s throws RecallContractError with code invalid_scorer_window (testing specialist #1)',
    (bad) => {
      writeEntry(root, makeRaw('alpha'));
      let thrown: unknown = null;
      try {
        recall(ctxFor(root), { query: 'alpha', scorerWindow: bad });
      } catch (err) {
        thrown = err;
      }
      // Per-iteration code assertion catches a regression where one of the
      // bad values (e.g. NaN) sneaks through and the throw comes from a
      // downstream FTS LIMIT instead of our typed validator.
      expect((thrown as { name?: string })?.name).toBe('RecallContractError');
      expect((thrown as { code?: string })?.code).toBe('invalid_scorer_window');
      expect(String((thrown as { message?: string })?.message)).toMatch(
        /scorerWindow must be a positive integer/,
      );
    },
  );

  it('limit semantics unchanged: caps base BM25 hits, fresh-tail/summary can expand', () => {
    // Pre-v1.7.0 behaviour: limit caps BM25 base, fresh-tail and summary
    // substitutions extend above. Verify F3 didn't change this.
    for (let i = 0; i < 10; i++) writeEntry(root, makeRaw(`omega ${i}`));
    const result = recall(ctxFor(root), {
      query: 'omega',
      limit: 3,
      freshTailCount: 5,
    });
    // Base ranked: <= limit (3). Fresh-tail can add more.
    // Ranked items mark isFreshTail on the recent set; a row may be both
    // a BM25 hit AND fresh-tail. The returned `results` length is
    // baseRanked + freshRanked-not-already-in-baseRanked + summaryRanked.
    expect(result.results.length).toBeGreaterThanOrEqual(3);
    // Some isFreshTail items should appear when freshTailCount=5 against
    // a 10-row population.
    const freshOnes = result.results.filter((r) => r.isFreshTail);
    expect(freshOnes.length).toBeGreaterThan(0);
  });

  it('scorerWindow=1 (smallest legal value) is accepted and honoured (v1.7.1 INFO #2)', () => {
    // Validator at src/api.ts accepts `>= 1` integers. A regression flipping
    // `< 1` to `<= 1` or `< 2` would not be caught by the existing 0-rejection
    // test alone. Pin the lower bound: scorerWindow=1 must NOT throw and the
    // candidate pool must shrink to exactly 1.
    for (let i = 0; i < 5; i++) writeEntry(root, makeRaw(`tau ${i}`));
    const result = recall(ctxFor(root), {
      query: 'tau',
      limit: 5,
      scorerWindow: 1,
    });
    expect(result.windowSize).toBe(1);
    // FTS5 LIMIT 1 against a >1-row matching population returns exactly 1.
    expect(result.total).toBe(1);
  });
});
