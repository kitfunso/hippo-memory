// The token ledger is SQLite-only, so a hook on a store that is not hippo.db must not create one under hippoRoot.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { adminActor } from '../src/api/index.js';
import { promptHookContext } from '../src/server.js';
import { sqliteStore } from '../src/store/sqlite/store.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ledger-nonsqlite-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('promptHookContext on a store that is not SQLite', () => {
  it('books no ledger row and leaves no hippo.db under the root', async () => {
    const donor = path.join(tmp, 'donor');
    fs.mkdirSync(donor);
    initStore(donor);
    const pin = createMemory('PINNED: always check the rollback plan', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(donor, { ...pin, pinned: true, origin_project: 'p' });
    const root = path.join(tmp, 'bare');
    fs.mkdirSync(root);
    const store = { ...sqliteStore(donor), localFiles: undefined };
    const ctx = { hippoRoot: root, tenantId: 'default', actor: adminActor('test'), store };
    const out = await promptHookContext(ctx, { sessionId: 's1', project: { name: 'p', legacyName: 'p' }, payload: { prompt: 'hi' } });
    expect(out.stdout).toContain('rollback plan');
    expect(fs.existsSync(path.join(root, 'hippo.db'))).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
