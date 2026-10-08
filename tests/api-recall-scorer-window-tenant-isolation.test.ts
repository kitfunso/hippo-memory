/**
 * v1.7.1 INFO #5 — scorerWindow does not leak across tenants.
 *
 * The store-side LIMIT inside loadSearchRows is applied AFTER the tenant
 * predicate (`WHERE tenant_id = ?`). A future refactor that moved the LIMIT
 * before the tenant filter would silently surface cross-tenant rows when
 * scorerWindow > tenant row count. Pin the contract on id-set, not on
 * `result.total` (misleading metadata — we want the actual rows checked).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, Layer, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { recall, type Context } from '../src/api.js';
import { _forceLikePathForTests } from '../src/store/search-rows.js';
import { makeRoot } from './_helpers/make-root.js';

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function ctxFor(root: string, tenantId: string): Context {
  return { hippoRoot: root, tenantId, actor: { subject: 'test:tenant-iso', role: 'admin' } };
}
function makeRaw(text: string, tenantId: string): MemoryEntry {
  return createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw',
    tenantId,
  });
}

describe('scorerWindow tenant isolation (v1.7.1 INFO #5)', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('f3-tenant'); });
  afterEach(() => safeRmSync(root));

  // The scope+tenant SQL clauses are appended to FOUR paths in loadSearchRows
  // (no-terms, FTS, LIKE fallback, full-store fallback). Cover three of the
  // four explicitly via the recall path: the FTS branch (terms match), the
  // no-terms branch (empty query), and the LIKE-fallback branch
  // (the _forceLikePathForTests switch). The full-store fallback fires only when
  // both FTS and LIKE return zero rows on terms — exotic enough that the
  // shared SQL builder is the relevant unit.

  function seedTwoTenants(N: number): Set<string> {
    const tenantAIds = new Set<string>();
    for (let i = 0; i < N; i++) {
      const e = makeRaw(`kappa A-${i}`, 'tenant-a');
      tenantAIds.add(e.id);
      writeEntry(root, e);
    }
    for (let i = 0; i < N; i++) writeEntry(root, makeRaw(`kappa B-${i}`, 'tenant-b'));
    return tenantAIds;
  }

  it('FTS path: wide scorerWindow under one tenant does not surface rows from another', () => {
    const N = 5;
    const tenantAIds = seedTwoTenants(N);
    const result = recall(ctxFor(root, 'tenant-a'), {
      query: 'kappa',
      limit: 100,
      scorerWindow: N + 5,
    });
    expect(result.results.length).toBe(N);
    for (const r of result.results) {
      expect(tenantAIds.has(r.id)).toBe(true);
      expect(r.content).not.toContain('B-');
    }
  });

  it('No-terms path: empty query under one tenant does not surface rows from another', () => {
    const N = 5;
    const tenantAIds = seedTwoTenants(N);
    const result = recall(ctxFor(root, 'tenant-a'), {
      query: '',
      limit: 100,
      scorerWindow: N + 5,
    });
    expect(result.results.length).toBe(N);
    for (const r of result.results) {
      expect(tenantAIds.has(r.id)).toBe(true);
      expect(r.content).not.toContain('B-');
    }
  });

  it('LIKE-fallback path: the forced LIKE route keeps tenant isolation', () => {
    const N = 5;
    const tenantAIds = seedTwoTenants(N);
    try {
      _forceLikePathForTests(true);
      const result = recall(ctxFor(root, 'tenant-a'), {
        query: 'kappa',
        limit: 100,
        scorerWindow: N + 5,
      });
      expect(result.results.length).toBe(N);
      for (const r of result.results) {
        expect(tenantAIds.has(r.id)).toBe(true);
        expect(r.content).not.toContain('B-');
      }
    } finally {
      _forceLikePathForTests(false);
    }
  });
});
