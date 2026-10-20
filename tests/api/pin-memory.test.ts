// api.memoryPin sets the flag through the store port, audits each call as a pin by the caller, and refuses rows out of reach.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminActor, NotFoundError, memoryPin } from '../../src/api/index.js';
import { memoryGet } from '../../src/api/memories/memories.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../../src/base/memory/memory.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

let root: string;

beforeEach(() => {
  root = makeRoot('api-pin-memory');
});

afterEach(() => {
  removeAfterRequest(root);
});

function seed(tenantId = 'default', scope: string | null = null): MemoryEntry {
  const entry = createMemory('the build cache lives on the second disk', {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    tenantId,
    scope,
  });
  writeEntry(root, entry);
  return entry;
}

describe('api.memoryPin', () => {
  it('pins then unpins, answering the row it wrote', async () => {
    const entry = seed();
    const ctx = apiCtx(root);

    expect((await memoryPin(ctx, entry.id, true)).pinned).toBe(true);
    expect((await memoryGet(ctx, entry.id))?.pinned).toBe(true);
    expect((await memoryPin(ctx, entry.id, false)).pinned).toBe(false);
    expect((await memoryGet(ctx, entry.id))?.pinned).toBe(false);
  });

  it('writes one pin audit row per call, by the Context actor, holding the flag it set', async () => {
    const entry = seed();
    const ctx = apiCtx(root, 'default', adminActor('dashboard'));

    await memoryPin(ctx, entry.id, true);
    await memoryPin(ctx, entry.id, false);

    const rows = await ctx.store.auditLog.listAuditEvents({ tenantId: 'default', op: 'pin' });
    expect(rows.sort((a, b) => a.id - b.id).map((r) => [r.actor, r.targetId, r.metadata])).toEqual([
      ['dashboard', entry.id, { pinned: true }],
      ['dashboard', entry.id, { pinned: false }],
    ]);
  });

  it("refuses another tenant's row and another person's personal row as not found, writing nothing", async () => {
    const elsewhere = seed('acme');
    const personal = seed('default', 'personal:private:alice');
    const ctx = apiCtx(root);

    await expect(memoryPin(ctx, elsewhere.id, true)).rejects.toThrow(NotFoundError);
    await expect(memoryPin(ctx, personal.id, true)).rejects.toThrow(NotFoundError);

    expect((await memoryGet(apiCtx(root, 'acme'), elsewhere.id))?.pinned).toBe(false);
    expect((await memoryGet(ctx, personal.id))?.pinned).toBe(false);
    expect(await ctx.store.auditLog.listAuditEvents({ tenantId: 'acme', op: 'pin' })).toEqual([]);
    expect(await ctx.store.auditLog.listAuditEvents({ tenantId: 'default', op: 'pin' })).toEqual([]);
  });

  it("pins the caller's own personal row", async () => {
    const personal = seed('default', 'personal:private:alice');
    const ctx = apiCtx(root, 'default', { subject: 'alice-key', role: 'member', owner: 'alice' });

    expect((await memoryPin(ctx, personal.id, true)).pinned).toBe(true);
  });
});
