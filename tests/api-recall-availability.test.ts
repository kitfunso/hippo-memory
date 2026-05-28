/**
 * J2 availability-bias — api.recall integration tests.
 *
 * Guards the two HIGH issues codex-review-critic caught at review round 1:
 *  - api.recall computes the hint over the SCOPE-FILTERED pool (`entries`), NOT
 *    the raw `all` load, so private / cross-scope rows never inflate the signal
 *    or leak hidden pool shape (HIGH-2).
 *  - api.recall does NOT compute/emit when opts.suppressAvailabilityHint is set
 *    (the MCP pipeline computes its own), so one recall never double-emits the
 *    audit op (HIGH-1).
 * Plus env-gate + audit-emission + result-immutability wiring.
 *
 * Real DB throughout (project convention).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createMemory, Layer, type MemoryKind } from '../src/memory.js';
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
function ctxFor(root: string): Context {
  return { hippoRoot: root, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
}
function countAuditOps(root: string, op: string): number {
  const db = openHippoDb(root);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE op = ?`).get(op) as { n: number };
    return row.n;
  } finally {
    closeHippoDb(db);
  }
}

/** Seed a query-matching memory with a controllable age (days) + optional scope.
 *  createMemory fixes created=now; we override it before writeEntry to age the row.
 *  last_retrieved stays recent so the row is not decayed out of recall. */
function seedAged(root: string, content: string, ageDays: number, scope?: string): string {
  const mem = createMemory(content, {
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw' as MemoryKind,
    tenantId: 'default',
    ...(scope !== undefined ? { scope } : {}),
  });
  mem.created = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  writeEntry(root, mem);
  return mem.id;
}

// Strong match carries all 3 query tokens; weak match carries 1. BM25 ranks the
// recent strong-match cluster into the top-K, leaving the older weak matches in
// the pool but out of the returned slice.
const QUERY = 'zephyr quasar nimbus';
function seedFiringFixture(root: string): void {
  for (let i = 0; i < 4; i++) seedAged(root, `zephyr quasar nimbus recent ${i}`, 0);
  for (let i = 0; i < 6; i++) seedAged(root, `zephyr older weak ${i}`, 40);
}

describe('api.recall availabilityHint (J2 integration)', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('j2-api'); delete process.env.HIPPO_AVAILABILITY; });
  afterEach(() => { safeRmSync(root); delete process.env.HIPPO_AVAILABILITY; });

  it('fires and emits exactly one audit row on a recency-biased recall', () => {
    seedFiringFixture(root);
    const result = recall(ctxFor(root), { query: QUERY, limit: 4 });
    expect(result.availabilityHint).toBeDefined();
    expect(result.availabilityHint!.recentCount).toBe(4);
    expect(result.availabilityHint!.returnedCount).toBe(4);
    expect(result.availabilityHint!.olderCandidatesPassedOver).toBeGreaterThanOrEqual(3);
    expect(result.availabilityHint!.source).toBe('j2-recency');
    expect(countAuditOps(root, 'recall_availability_detected')).toBe(1);
  });

  it('HIPPO_AVAILABILITY=off suppresses the hint and the audit', () => {
    seedFiringFixture(root);
    process.env.HIPPO_AVAILABILITY = 'off';
    const result = recall(ctxFor(root), { query: QUERY, limit: 4 });
    expect(result.availabilityHint).toBeUndefined();
    expect(countAuditOps(root, 'recall_availability_detected')).toBe(0);
  });

  it('opts.suppressAvailabilityHint suppresses hint + audit (MCP double-emit guard)', () => {
    seedFiringFixture(root);
    const result = recall(ctxFor(root), { query: QUERY, limit: 4, suppressAvailabilityHint: true });
    expect(result.availabilityHint).toBeUndefined();
    expect(countAuditOps(root, 'recall_availability_detected')).toBe(0);
  });

  it('counts only scope-eligible olds: private rows excluded from the pool (HIGH-2 guard)', () => {
    for (let i = 0; i < 4; i++) seedAged(root, `zephyr quasar nimbus recent ${i}`, 0);
    for (let i = 0; i < 6; i++) seedAged(root, `zephyr older weak public ${i}`, 40);
    for (let i = 0; i < 3; i++) seedAged(root, `zephyr older weak private ${i}`, 40, 'slack:private:x');
    // No scope on the recall = default-deny private rows. With the fix (pool=entries)
    // only the 6 public olds count; the buggy pool=all would have counted 9.
    const result = recall(ctxFor(root), { query: QUERY, limit: 4 });
    expect(result.availabilityHint).toBeDefined();
    expect(result.availabilityHint!.olderCandidatesPassedOver).toBe(6);
  });

  it('does not change result ordering (soft warning only)', () => {
    seedFiringFixture(root);
    const withHint = recall(ctxFor(root), { query: QUERY, limit: 4 });
    process.env.HIPPO_AVAILABILITY = 'off';
    const without = recall(ctxFor(root), { query: QUERY, limit: 4 });
    expect(withHint.results.map((r) => r.id)).toEqual(without.results.map((r) => r.id));
  });
});
