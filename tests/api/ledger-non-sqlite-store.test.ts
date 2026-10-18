// The token ledger is SQLite-only, so a hook on a store that is not hippo.db must not create one under hippoRoot.
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { adminActor } from '../../src/api/index.js';
import { promptHookContext } from '../../src/server.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadConfig } from '../../src/core/config.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { initStore } from '../../src/store/sqlite/handles.js';

let tmp: string;

beforeEach(() => {
  tmp = makeRoot('ledger-nonsqlite', { init: false });
});

describe('promptHookContext on a store that is not SQLite', () => {
  it('books no ledger row and leaves no hippo.db under the root', async () => {
    const donor = path.join(tmp, 'donor');
    fs.mkdirSync(donor);
    initStore(donor);
    const pin = createMemory('PINNED: always check the rollback plan', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(donor, { ...pin, pinned: true, originProject: 'p' });
    const root = path.join(tmp, 'bare');
    fs.mkdirSync(root);
    const store = { ...sqliteStore(donor), localFiles: undefined };
    const ctx = { hippoRoot: root, tenantId: 'default', actor: adminActor('test'), store, config: loadConfig(root) };
    const out = await promptHookContext(ctx, {
      sessionId: 's1',
      project: { name: 'p', legacyName: 'p' },
      payload: { prompt: 'hi' },
    });
    expect(out.stdout).toContain('rollback plan');
    expect(fs.existsSync(path.join(root, 'hippo.db'))).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
