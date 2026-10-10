// reject and authKeyTenant read through ctx.store when the context names one, never the folder hippoRoot names.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { adminActor, authCreate, authKeyTenant, NotFoundError, reject, type HippoDbContext } from '../src/api/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { readEntry } from '../src/store/entry-reads.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { listRejectionsForTenant } from '../src/trust/reject-flow.js';
import { makeRoot } from './_helpers/make-root.js';
import { portOnlyStore } from './_helpers/port-only-store.js';

const TENANT = 'acme';
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function root(): string {
  const made = makeRoot('api-port-reads');
  roots.push(made);
  return made;
}

function ctxAt(hippoRoot: string): HippoDbContext {
  return { hippoRoot, tenantId: TENANT, actor: adminActor('cli') };
}

describe('reads through a served store', () => {
  it('reject by id looks the memory up in the served store', async () => {
    const served = root();
    const plain = root();
    const onlyInFolder = createMemory('the folder holds this row, the served store does not', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: TENANT });
    writeEntry(plain, onlyInFolder);
    const ctx = { ...ctxAt(plain), store: portOnlyStore(served) };
    await expect(reject(ctx, { memoryId: onlyInFolder.id, reason: 'wrong' })).rejects.toThrow(NotFoundError);
    expect(readEntry(plain, onlyInFolder.id, TENANT)).not.toBeNull();
    expect(listRejectionsForTenant(plain, TENANT)).toEqual([]);
  });

  it('authKeyTenant finds a key in the served store', async () => {
    const served = root();
    const { keyId } = authCreate(ctxAt(served), { label: 'served key' });
    const ctx = { ...ctxAt(root()), tenantId: 'default', store: portOnlyStore(served) };
    expect(await authKeyTenant(ctx, keyId)).toBe(TENANT);
    expect(await authKeyTenant({ ...ctx, store: undefined }, keyId)).toBeUndefined();
  });
});
