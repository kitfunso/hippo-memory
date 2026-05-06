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
function ctxFor(root: string, tenantId: string): Context {
  return { hippoRoot: root, tenantId, actor: 'test:tenant-iso' };
}
function makeRaw(text: string, tenantId: string): MemoryEntry {
  return createMemory(text, {
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw' as MemoryKind,
    tenantId,
  });
}

describe('scorerWindow tenant isolation (v1.7.1 INFO #5)', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('f3-tenant'); });
  afterEach(() => safeRmSync(root));

  it('wide scorerWindow under one tenant does not surface rows from another', () => {
    const N = 5;
    const tenantAIds = new Set<string>();
    for (let i = 0; i < N; i++) {
      const e = makeRaw(`kappa A-${i}`, 'tenant-a');
      tenantAIds.add(e.id);
      writeEntry(root, e);
    }
    // Tenant B: N rows ALSO matching 'kappa'. If LIMIT moved before the
    // tenant predicate, scorerWindow=N+5 under tenant-a could pull tenant-b
    // rows into the candidate pool.
    for (let i = 0; i < N; i++) writeEntry(root, makeRaw(`kappa B-${i}`, 'tenant-b'));

    const result = recall(ctxFor(root, 'tenant-a'), {
      query: 'kappa',
      limit: 100,
      scorerWindow: N + 5,
    });
    // Asserted on the actual returned id-set, not result.total.
    expect(result.results.length).toBe(N);
    for (const r of result.results) {
      expect(tenantAIds.has(r.id)).toBe(true);
      expect(r.content).not.toContain('B-');
    }
  });
});
