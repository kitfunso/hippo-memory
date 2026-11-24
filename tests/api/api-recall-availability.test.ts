import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { Layer } from '../../src/base/memory/entry.js';
import { retrieve } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

afterEach(() => {
  vi.unstubAllEnvs();
});
const { writeEntry, apiCtx } = sessionPerTest();

function ctxFor(root: string): FullContext {
  return apiCtx(root, 'default', { subject: 'cli', role: 'admin' });
}
function countAuditOps(root: string, op: string): number {
  const db = openHippoDb(root);
  try {
    // SAFETY: SELECT COUNT(*) AS n always returns exactly one row with a numeric n column.
    const row = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE op = ?`).get(op) as { n: number };
    return row.n;
  } finally {
    closeHippoDb(db);
  }
}

function seedAged(root: string, content: string, ageDays: number, scope?: string): string {
  const options: Parameters<typeof createMemory>[1] = {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw',
    tenantId: 'default',
  };
  if (scope !== undefined) options.scope = scope;
  const mem = createMemory(content, options);
  mem.created = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  writeEntry(root, mem);
  return mem.id;
}

const QUERY = 'zephyr quasar nimbus';
function seedFiringFixture(root: string): void {
  for (let i = 0; i < 4; i++) seedAged(root, `zephyr quasar nimbus recent ${i}`, 0);
  for (let i = 0; i < 6; i++) seedAged(root, `zephyr older weak ${i}`, 40);
}

describe('api.recall availabilityHint', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('j2-api');
    vi.stubEnv('HIPPO_AVAILABILITY', undefined);
  });

  it('fires and emits exactly one audit row on a recency-biased recall', async () => {
    seedFiringFixture(root);
    const result = await retrieve(ctxFor(root), { query: QUERY, window: { limit: 4 } });
    expect(result.availabilityHint!.recentCount).toBe(4);
    expect(result.availabilityHint!.returnedCount).toBe(4);
    expect(result.availabilityHint!.olderCandidatesPassedOver).toBeGreaterThanOrEqual(3);
    expect(result.availabilityHint!.source).toBe('j2-recency');
    expect(countAuditOps(root, 'recall_availability_detected')).toBe(1);
  });

  it('the root turning availability off (HIPPO_AVAILABILITY=off) suppresses the hint and the audit', async () => {
    seedFiringFixture(root);
    const ctx = ctxFor(root);
    const off = { ...ctx, config: { ...ctx.config, runtime: { availabilityHint: false } } };
    const result = await retrieve(off, { query: QUERY, window: { limit: 4 } });
    expect(result.availabilityHint).toBeUndefined();
    expect(countAuditOps(root, 'recall_availability_detected')).toBe(0);
  });

  it('opts.suppressAvailabilityHint suppresses hint + audit (MCP double-emit guard)', async () => {
    seedFiringFixture(root);
    const result = await retrieve(ctxFor(root), {
      query: QUERY,
      window: { limit: 4 },
      hints: { suppressAvailabilityHint: true },
    });
    expect(result.availabilityHint).toBeUndefined();
    expect(countAuditOps(root, 'recall_availability_detected')).toBe(0);
  });

  it('counts only scope-eligible olds: private rows excluded from the pool (HIGH-2 guard)', async () => {
    for (let i = 0; i < 4; i++) seedAged(root, `zephyr quasar nimbus recent ${i}`, 0);
    for (let i = 0; i < 6; i++) seedAged(root, `zephyr older weak public ${i}`, 40);
    for (let i = 0; i < 3; i++) seedAged(root, `zephyr older weak private ${i}`, 40, 'slack:private:x');
    const result = await retrieve(ctxFor(root), { query: QUERY, window: { limit: 4 } });
    expect(result.availabilityHint!.olderCandidatesPassedOver).toBe(6);
  });

  it('does not change result ordering (soft warning only)', async () => {
    seedFiringFixture(root);
    const withHint = await retrieve(ctxFor(root), { query: QUERY, window: { limit: 4 } });
    vi.stubEnv('HIPPO_AVAILABILITY', 'off');
    const without = await retrieve(ctxFor(root), { query: QUERY, window: { limit: 4 } });
    expect(withHint.results.map((r) => r.id)).toEqual(without.results.map((r) => r.id));
  });
});
