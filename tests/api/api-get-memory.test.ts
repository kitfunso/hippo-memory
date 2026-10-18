// memoryGet replaces readEntry in CLI verbs, so it must answer exactly what readEntry answers for every kind of row an id can name.
import type { FullContext } from '../_helpers/api-ctx.js';
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { memoryGet } from '../../src/api/memories/memories.js';
import { rawArchive } from '../../src/api/memories/promote.js';
import { adminActor } from '../../src/api/types.js';
import {
  createMemory,
  DEFAULT_HALF_LIFE_DAYS,
  type CreateMemoryOptions,
  type MemoryEntry,
} from '../../src/core/memory.js';
import { insertDormantRow } from '../../src/store/sqlite/dormant-rows.js';
import { makeRoot } from '../_helpers/make-root.js';
import { portOnlyStore } from '../_helpers/port-only-store.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { readEntry, writeEntry } from '../_helpers/root-forms.js';
import { openStore } from '../../src/store/sqlite/handles.js';

const TENANT = 'acme';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const made = makeRoot('get-memory');
  roots.push(made);
  return made;
}

function ctxAt(hippoRoot: string): FullContext {
  return apiCtx(hippoRoot, TENANT, adminActor('test'));
}

function seed(
  hippoRoot: string,
  id: string,
  options: Partial<CreateMemoryOptions> = {},
  fields: Partial<MemoryEntry> = {},
): MemoryEntry {
  const entry = {
    ...createMemory(`row ${id}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: TENANT, ...options }),
    id,
    ...fields,
  };
  writeEntry(hippoRoot, entry);
  return entry;
}

async function expectSameAnswer(hippoRoot: string, id: string): Promise<MemoryEntry | null> {
  const viaApi = await memoryGet(ctxAt(hippoRoot), id);
  expect(viaApi).toEqual(readEntry(hippoRoot, id, TENANT));
  return viaApi;
}

describe('memoryGet answers what readEntry answers', () => {
  it('a row in the caller tenant', async () => {
    const r = root();
    seed(r, 'mem_plain', { tags: ['billing'] });
    expect((await expectSameAnswer(r, 'mem_plain'))?.tags).toEqual(['billing']);
  });

  it('a row of another tenant reads as null', async () => {
    const r = root();
    seed(r, 'mem_elsewhere', { tenantId: 'other' });
    expect(await expectSameAnswer(r, 'mem_elsewhere')).toBeNull();
  });

  it('a missing id reads as null', async () => {
    expect(await expectSameAnswer(root(), 'mem_missing')).toBeNull();
  });

  it('a superseded row is still returned', async () => {
    const r = root();
    seed(r, 'mem_new');
    seed(r, 'mem_old', {}, { supersededBy: 'mem_new', kind: 'superseded' });
    expect((await expectSameAnswer(r, 'mem_old'))?.supersededBy).toBe('mem_new');
  });

  it('a raw row archived through the api has left memories and reads as null', async () => {
    const r = root();
    seed(r, 'mem_raw', { kind: 'raw' });
    await rawArchive(ctxAt(r), 'mem_raw', 'asked to remove it');
    expect(await expectSameAnswer(r, 'mem_raw')).toBeNull();
  });

  it('a row still in memories with kind archived is returned', async () => {
    const r = root();
    seed(r, 'mem_archived', {}, { kind: 'archived' });
    expect((await expectSameAnswer(r, 'mem_archived'))?.kind).toBe('archived');
  });

  it('a dormant row, which lives outside the memories table, reads as null', async () => {
    const r = root();
    const entry = {
      ...createMemory('faded row', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: TENANT }),
      id: 'mem_dormant',
    };
    const db = openStore(r);
    try {
      insertDormantRow(db, { entry, strength: 0.01, reason: 'decay', dormantAt: '2026-01-01T00:00:00.000Z' });
    } finally {
      db.close();
    }
    expect(await expectSameAnswer(r, 'mem_dormant')).toBeNull();
  });

  it('reads through the context store, not the folder hippoRoot names', async () => {
    const served = root();
    const plain = seed(served, 'mem_served');
    const ctx = { ...ctxAt(root()), store: portOnlyStore(served) };
    expect(await memoryGet(ctx, 'mem_served')).toEqual(readEntry(served, 'mem_served', TENANT));
    expect((await memoryGet(ctx, 'mem_served'))?.content).toBe(plain.content);
    expect(await memoryGet(ctxAt(ctx.hippoRoot), 'mem_served')).toBeNull();
  });
});
