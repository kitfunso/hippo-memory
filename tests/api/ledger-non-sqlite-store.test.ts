// A hook on a store that is not hippo.db never creates one under hippoRoot; the store's own groups decide if it books.
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { adminActor } from '../../src/api/index.js';
import { promptHookContext } from '../../src/server.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { withoutFolderGroups } from '../_helpers/port-only-store.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadConfig } from '../../src/base/config/config.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { tokensBySession } from '../../src/store/sqlite/fixtures.js';

let tmp: string;

beforeEach(() => {
  tmp = makeRoot('ledger-nonsqlite', { init: false });
});

/** A pinned row in a fresh store folder, the add-on stores' rows. */
function donorStore(): string {
  const donor = path.join(tmp, 'donor');
  fs.mkdirSync(donor);
  initTestStore(donor);
  const pin = createMemory('PINNED: always check the rollback plan', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
  writeEntry(donor, { ...pin, pinned: true, originProject: 'p' });
  return donor;
}

function ledgerRows(donor: string, sessionId: string): number {
  const db = openHippoDb(donor);
  try {
    return tokensBySession(db, 'default', '1970-01-01T00:00:00.000Z').filter((r) => r.sessionId === sessionId).length;
  } finally {
    closeHippoDb(db);
  }
}

const REQUEST = { sessionId: 's1', project: { name: 'p', legacyName: 'p' }, payload: { prompt: 'hi' } };

describe('promptHookContext on a store that is not SQLite', () => {
  it('books no ledger row and leaves no hippo.db under the root', async () => {
    const donor = donorStore();
    const root = path.join(tmp, 'bare');
    fs.mkdirSync(root);
    const store = { ...withoutFolderGroups(sqliteStore(donor)), kind: 'other' };
    const ctx = { hippoRoot: root, tenantId: 'default', actor: adminActor('test'), store, config: loadConfig(root) };
    const out = await promptHookContext(ctx, REQUEST);
    expect(out.stdout).toContain('rollback plan');
    expect(fs.existsSync(path.join(root, 'hippo.db'))).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(ledgerRows(donor, 's1')).toBe(0);
  });

  it('gives an add-on store that serves folderFiles and a ledger the reach a root gives it, so its ledger books', async () => {
    const donor = donorStore();
    const root = path.join(tmp, 'bare');
    fs.mkdirSync(root);
    const { folderFiles, ledger } = sqliteStore(donor);
    // String keys only, so the copy is not marked as hippo.db: the port groups alone decide its reach.
    const store = { ...withoutFolderGroups(sqliteStore(donor)), kind: 'other', folderFiles, ledger };
    const ctx = { hippoRoot: root, tenantId: 'default', actor: adminActor('test'), store, config: loadConfig(root) };
    const out = await promptHookContext(ctx, REQUEST);
    expect(out.stdout).toContain('rollback plan');
    expect(ledgerRows(donor, 's1')).toBeGreaterThan(0);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
