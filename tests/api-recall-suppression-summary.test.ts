/**
 * v1.12.13 / C5 — WYSIATI cutoff transparency (Track C Pineal Gland, C5).
 *
 * api.recall populates RecallResult.suppressionSummary with 6 counters
 * describing what was excluded and why. Test asserts: shape always present
 * when produced by api.recall; counters reflect actual filter activity in
 * the api.recall pipeline; back-compat preserved (existing fields unchanged).
 *
 * Real DB throughout (project convention: always use real DB for tests).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, Layer, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { retrieve, type Context } from '../src/api/index.js';
import { makeRoot } from './_helpers/make-root.js';

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function ctxFor(root: string, tenantId: string = 'default'): Context {
  return { hippoRoot: root, tenantId, actor: { subject: 'test:c5', role: 'admin' } };
}
function makeRaw(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  return createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw',
    tenantId: opts.tenantId ?? 'default',
  });
}

describe('RecallResult.suppressionSummary', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('c5'); });
  afterEach(() => safeRmSync(root));

  it('always present on api.recall response (back-compat preserved on existing fields)', async () => {
    writeEntry(root, makeRaw('alpha'));
    const result = await retrieve(ctxFor(root), { query: 'alpha' });
    // Existing fields unchanged.
    expect(result.results).toBeDefined();
    expect(result.total).toBeDefined();
    expect(result.tokens).toBeDefined();
    expect(result.windowSize).toBe(200);
    // New field always present from api.recall.
    expect(result.suppressionSummary).toBeDefined();
    // Each field is a non-negative integer counter (RecallSuppressionSummary,
    // src/api/index.ts); Number.isInteger is the domain-correct runtime shape check.
    expect(Number.isInteger(result.suppressionSummary!.totalCandidates)).toBe(true);
    expect(Number.isInteger(result.suppressionSummary!.droppedPreRank)).toBe(true);
    expect(Number.isInteger(result.suppressionSummary!.droppedByBudget)).toBe(true);
    expect(Number.isInteger(result.suppressionSummary!.summarySubstitutionsAdded)).toBe(true);
    expect(Number.isInteger(result.suppressionSummary!.freshTailAdded)).toBe(true);
    expect(Number.isInteger(result.suppressionSummary!.suppressedByInterference)).toBe(true);
  });

  it('totalCandidates reflects loaded candidate pool (post tenant + SQL scope predicate)', async () => {
    // Insert 5 query-matching memories; expect totalCandidates >= 5.
    for (let i = 0; i < 5; i++) writeEntry(root, makeRaw(`zeta ${i}`));
    const result = await retrieve(ctxFor(root), { query: 'zeta', limit: 10 });
    expect(result.suppressionSummary!.totalCandidates).toBeGreaterThanOrEqual(5);
  });

  it('droppedByBudget reflects rows excluded by the final limit slice', async () => {
    // Insert 20 matching memories; limit to 5; expect droppedByBudget = 15.
    for (let i = 0; i < 20; i++) writeEntry(root, makeRaw(`omega ${i}`));
    const result = await retrieve(ctxFor(root), { query: 'omega', limit: 5 });
    expect(result.results.length).toBe(5);
    expect(result.suppressionSummary!.droppedByBudget).toBe(15);
  });

  it('droppedByBudget = 0 when limit >= candidates (no overflow)', async () => {
    for (let i = 0; i < 3; i++) writeEntry(root, makeRaw(`kappa ${i}`));
    const result = await retrieve(ctxFor(root), { query: 'kappa', limit: 10 });
    expect(result.suppressionSummary!.droppedByBudget).toBe(0);
    // suppressionSummary still defined even when no overflow.
    expect(result.suppressionSummary).toBeDefined();
  });

  it('all 6 counters are non-negative integers', async () => {
    writeEntry(root, makeRaw('delta'));
    const result = await retrieve(ctxFor(root), { query: 'delta' });
    const s = result.suppressionSummary!;
    expect(Number.isInteger(s.totalCandidates)).toBe(true);
    expect(s.totalCandidates).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(s.droppedPreRank)).toBe(true);
    expect(s.droppedPreRank).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(s.droppedByBudget)).toBe(true);
    expect(s.droppedByBudget).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(s.summarySubstitutionsAdded)).toBe(true);
    expect(s.summarySubstitutionsAdded).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(s.freshTailAdded)).toBe(true);
    expect(s.freshTailAdded).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(s.suppressedByInterference)).toBe(true);
    expect(s.suppressedByInterference).toBeGreaterThanOrEqual(0);
  });

  // v0.33 / J1 (v1.13.2): the original "always 0 in v1.12.13" assertion is
  // RELAXED. J1 lights up the counter via R2 memory_dominance detection,
  // so the counter now reads 0 when J1 is off OR no R2 fires, and non-zero
  // when R2 fires. This test asserts the no-history / no-snapshot case
  // (which keeps the counter at 0). The non-zero-on-R2 case is tested by
  // tests/api-recall-suppressed-interference.test.ts.
  it('suppressedByInterference is 0 when J1 is off or no R2 detected (default no-history path)', async () => {
    writeEntry(root, makeRaw('iota'));
    const result = await retrieve(ctxFor(root), { query: 'iota' });
    expect(result.suppressionSummary!.suppressedByInterference).toBe(0);
  });

  it('retrieve returns the same ids in the same order and the same summary on a repeat call', async () => {
    for (let i = 0; i < 8; i++) writeEntry(root, makeRaw(`parity ${i} shared token`));
    writeEntry(root, { ...makeRaw('parity old shared token'), superseded_by: 'mem_newer' });
    const opts = { query: 'parity shared', limit: 5 };
    const first = await retrieve(ctxFor(root), opts);
    const again = await retrieve(ctxFor(root), opts);
    expect(again.results.map((r) => r.id)).toEqual(first.results.map((r) => r.id));
    expect(again.suppressionSummary).toEqual(first.suppressionSummary);
    expect(first.suppressionSummary!.droppedByBudget).toBeGreaterThan(0);
  });
});
