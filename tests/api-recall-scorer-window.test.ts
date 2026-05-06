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
  return { hippoRoot: root, tenantId, actor: 'test:f3' };
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

  it('scorerWindow can widen the candidate pool above limit', () => {
    // Insert 30 raws all matching the query; default candidate pool is
    // 200 (more than enough), but verify result.total reflects what
    // loadSearchEntries returned (the candidate pool size after FTS+LIMIT,
    // pre-slice).
    for (let i = 0; i < 30; i++) writeEntry(root, makeRaw(`zeta ${i}`));
    const result = recall(ctxFor(root), { query: 'zeta', limit: 5, scorerWindow: 25 });
    // total reflects the candidate pool the scorer actually evaluated
    // (capped at scorerWindow). limit caps base results in the returned
    // ranked list, but fresh-tail/summary can extend.
    expect(result.windowSize).toBe(25);
    // Default-deny scope filter does not affect raws with scope=null,
    // so we expect a non-empty candidate pool.
    expect(result.total).toBeLessThanOrEqual(25);
    expect(result.total).toBeGreaterThan(0);
  });

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
});
