import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { retrieve } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, apiCtx } = sessionPerTest();

function ctxFor(root: string, tenantId: string): FullContext {
  return apiCtx(root, tenantId, { subject: 'test:tenant-iso', role: 'admin' });
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

describe('scorerWindow tenant isolation', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('f3-tenant');
  });

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

  it('FTS path: wide scorerWindow under one tenant does not surface rows from another', async () => {
    const N = 5;
    const tenantAIds = seedTwoTenants(N);
    const result = await retrieve(ctxFor(root, 'tenant-a'), {
      query: 'kappa',
      window: { limit: 100, scorerWindow: N + 5 },
    });
    expect(result.results.length).toBe(N);
    for (const r of result.results) {
      expect(tenantAIds.has(r.id)).toBe(true);
      expect(r.content).not.toContain('B-');
    }
  });

  it('No-terms path: empty query under one tenant does not surface rows from another', async () => {
    const N = 5;
    const tenantAIds = seedTwoTenants(N);
    const result = await retrieve(ctxFor(root, 'tenant-a'), {
      query: '',
      window: { limit: 100, scorerWindow: N + 5 },
    });
    expect(result.results.length).toBe(N);
    for (const r of result.results) {
      expect(tenantAIds.has(r.id)).toBe(true);
      expect(r.content).not.toContain('B-');
    }
  });

  it('LIKE-fallback path: a part-word query keeps tenant isolation', async () => {
    const N = 5;
    const tenantAIds = seedTwoTenants(N);
    const result = await retrieve(ctxFor(root, 'tenant-a'), {
      query: 'kapp',
      window: { limit: 100, scorerWindow: N + 5 },
    });
    expect(result.results.length).toBe(N);
    for (const r of result.results) {
      expect(tenantAIds.has(r.id)).toBe(true);
      expect(r.content).not.toContain('B-');
    }
  });
});
