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
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, MemoryKind, type MemoryEntry } from '../src/memory.js';
import { recall, buildSuppressionSummary, type Context } from '../src/api.js';

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
  return { hippoRoot: root, tenantId, actor: { subject: 'test:c5', role: 'admin' } };
}
function makeRaw(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  return createMemory(text, {
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw' as MemoryKind,
    tenantId: opts.tenantId ?? 'default',
  });
}

describe('RecallResult.suppressionSummary (C5 WYSIATI, v1.12.13)', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('c5'); });
  afterEach(() => safeRmSync(root));

  it('always present on api.recall response (back-compat preserved on existing fields)', () => {
    writeEntry(root, makeRaw('alpha'));
    const result = recall(ctxFor(root), { query: 'alpha' });
    // Existing fields unchanged.
    expect(result.results).toBeDefined();
    expect(result.total).toBeDefined();
    expect(result.tokens).toBeDefined();
    expect(result.windowSize).toBe(200);
    // New field always present from api.recall.
    expect(result.suppressionSummary).toBeDefined();
    expect(typeof result.suppressionSummary!.totalCandidates).toBe('number');
    expect(typeof result.suppressionSummary!.droppedPreRank).toBe('number');
    expect(typeof result.suppressionSummary!.droppedByBudget).toBe('number');
    expect(typeof result.suppressionSummary!.summarySubstitutionsAdded).toBe('number');
    expect(typeof result.suppressionSummary!.freshTailAdded).toBe('number');
    expect(typeof result.suppressionSummary!.suppressedByInterference).toBe('number');
  });

  it('totalCandidates reflects loaded candidate pool (post tenant + SQL scope predicate)', () => {
    // Insert 5 query-matching memories; expect totalCandidates >= 5.
    for (let i = 0; i < 5; i++) writeEntry(root, makeRaw(`zeta ${i}`));
    const result = recall(ctxFor(root), { query: 'zeta', limit: 10 });
    expect(result.suppressionSummary!.totalCandidates).toBeGreaterThanOrEqual(5);
  });

  it('droppedByBudget reflects rows excluded by the final limit slice', () => {
    // Insert 20 matching memories; limit to 5; expect droppedByBudget = 15.
    for (let i = 0; i < 20; i++) writeEntry(root, makeRaw(`omega ${i}`));
    const result = recall(ctxFor(root), { query: 'omega', limit: 5 });
    expect(result.results.length).toBe(5);
    expect(result.suppressionSummary!.droppedByBudget).toBe(15);
  });

  it('droppedByBudget = 0 when limit >= candidates (no overflow)', () => {
    for (let i = 0; i < 3; i++) writeEntry(root, makeRaw(`kappa ${i}`));
    const result = recall(ctxFor(root), { query: 'kappa', limit: 10 });
    expect(result.suppressionSummary!.droppedByBudget).toBe(0);
    // suppressionSummary still defined even when no overflow.
    expect(result.suppressionSummary).toBeDefined();
  });

  it('all 6 counters are non-negative integers', () => {
    writeEntry(root, makeRaw('delta'));
    const result = recall(ctxFor(root), { query: 'delta' });
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
  // tests/api-recall-suppressed-interference-j1.test.ts.
  it('suppressedByInterference is 0 when J1 is off or no R2 detected (default no-history path)', () => {
    writeEntry(root, makeRaw('iota'));
    const result = recall(ctxFor(root), { query: 'iota' });
    expect(result.suppressionSummary!.suppressedByInterference).toBe(0);
  });
});

describe('buildSuppressionSummary helper (C5, v1.12.13)', () => {
  it('passes camelCase input through to camelCase output unchanged', () => {
    const out = buildSuppressionSummary({
      totalCandidates: 10,
      droppedPreRank: 2,
      droppedByBudget: 3,
      summarySubstitutionsAdded: 1,
      freshTailAdded: 4,
      suppressedByInterference: 0,
    });
    expect(out.totalCandidates).toBe(10);
    expect(out.droppedPreRank).toBe(2);
    expect(out.droppedByBudget).toBe(3);
    expect(out.summarySubstitutionsAdded).toBe(1);
    expect(out.freshTailAdded).toBe(4);
    expect(out.suppressedByInterference).toBe(0);
  });

  it('returns a fresh object each call (no shared mutable state)', () => {
    const counts = {
      totalCandidates: 1,
      droppedPreRank: 0,
      droppedByBudget: 0,
      summarySubstitutionsAdded: 0,
      freshTailAdded: 0,
      suppressedByInterference: 0,
    };
    const a = buildSuppressionSummary(counts);
    const b = buildSuppressionSummary(counts);
    expect(a).not.toBe(b);
    a.totalCandidates = 99;
    expect(b.totalCandidates).toBe(1);
  });
});
