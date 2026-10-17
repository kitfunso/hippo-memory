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

import type { FullContext } from './_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, Layer, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { retrieve } from '../src/api/index.js';
import { makeRoot } from './_helpers/make-root.js';
import { apiCtx } from './_helpers/api-ctx.js';

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function ctxFor(root: string, tenantId: string = 'default'): FullContext {
  return apiCtx(root, tenantId, { subject: 'test:c5', role: 'admin' });
}
function makeRaw(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  return createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw',
    tenantId: opts.tenant_id ?? 'default',
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
    const s = result.suppressionSummary!;
    for (const n of [s.totalCandidates, s.droppedPreRank, s.droppedByBudget, s.summarySubstitutionsAdded, s.freshTailAdded, s.suppressedByInterference]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
  });

  it('totalCandidates reflects loaded candidate pool (post tenant + SQL scope predicate)', async () => {
    // Insert 5 query-matching memories; expect totalCandidates >= 5.
    for (let i = 0; i < 5; i++) writeEntry(root, makeRaw(`zeta ${i}`));
    const result = await retrieve(ctxFor(root), { query: 'zeta', window: { limit: 10 } });
    expect(result.suppressionSummary!.totalCandidates).toBeGreaterThanOrEqual(5);
  });

  it('droppedByBudget reflects rows excluded by the final limit slice', async () => {
    // Insert 20 matching memories; limit to 5; expect droppedByBudget = 15.
    for (let i = 0; i < 20; i++) writeEntry(root, makeRaw(`omega ${i}`));
    const result = await retrieve(ctxFor(root), { query: 'omega', window: { limit: 5 } });
    expect(result.results.length).toBe(5);
    expect(result.suppressionSummary!.droppedByBudget).toBe(15);
  });

  it('droppedByBudget = 0 when limit >= candidates (no overflow)', async () => {
    for (let i = 0; i < 3; i++) writeEntry(root, makeRaw(`kappa ${i}`));
    const result = await retrieve(ctxFor(root), { query: 'kappa', window: { limit: 10 } });
    expect(result.suppressionSummary!.droppedByBudget).toBe(0);
    // suppressionSummary still defined even when no overflow.
    expect(result.suppressionSummary).toBeDefined();
  });

  it('retrieve returns the same ids in the same order and the same summary on a repeat call', async () => {
    for (let i = 0; i < 8; i++) writeEntry(root, makeRaw(`parity ${i} shared token`));
    writeEntry(root, { ...makeRaw('parity old shared token'), superseded_by: 'mem_newer' });
    const opts = { query: 'parity shared', window: { limit: 5 } };
    const first = await retrieve(ctxFor(root), opts);
    const again = await retrieve(ctxFor(root), opts);
    expect(again.results.map((r) => r.id)).toEqual(first.results.map((r) => r.id));
    expect(again.suppressionSummary).toEqual(first.suppressionSummary);
    expect(first.suppressionSummary!.droppedByBudget).toBeGreaterThan(0);
  });
});
