// An EntryTarget with no role reads as a member key with no grants: a restricted row stays out of reach, an unrestricted one is not.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import { NotFoundError } from '../../src/server.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadEntriesByIds, writeEntry } from '../_helpers/root-forms.js';

const OPS = 'slack:private:Cops';
const target = { tenantId: 'default', actor: 'addon', ownScope: null } as const;

let root: string;
let restricted: MemoryEntry;
let open: MemoryEntry;
const kept = (): string[] => loadEntriesByIds(root, [restricted.id, open.id], 'default').map((e) => e.id);

beforeEach(() => {
  root = makeRoot('entry-target-no-role', { config: { embeddings: { enabled: false } } });
  restricted = createMemory('the ops rota sits in the locked channel', { tenantId: 'default', scope: OPS });
  open = createMemory('deploys go out on tuesdays', { tenantId: 'default' });
  for (const entry of [restricted, open]) writeEntry(root, entry, { actor: 'cli' });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('an EntryTarget with no role', () => {
  it('cannot forget or archive a restricted row, and the row survives', async () => {
    const { entryWrites } = sqliteStore(root);
    await expect(entryWrites.forget({ ...target, id: restricted.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      entryWrites.archiveRaw({ ...target, id: restricted.id, reason: 'source deleted' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(kept()).toContain(restricted.id);
  });

  it('can still forget its own unrestricted row', async () => {
    await sqliteStore(root).entryWrites.forget({ ...target, id: open.id });
    expect(kept()).toEqual([restricted.id]);
  });
});
