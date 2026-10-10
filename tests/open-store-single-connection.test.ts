// initStore + a second openHippoDb was two connections per loader; openStore
// runs init on the one connection the caller keeps. Real SQLite store, no mocks.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'module';
import { initStore, openStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { loadAmbientCandidates } from '../src/store/candidates.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { closeHippoDb, type DatabaseSyncLike } from '../src/db/index.js';

const require = createRequire(import.meta.url);
// SAFETY: node:sqlite has no bundled types; mirrors tests/db-open-write-free.test.ts.
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: { prototype: { prepare: (sql: string) => object } };
};

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-f3-openstore-'));
  initStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Counts distinct connection objects (`this`) any `.prepare()` call was made on. */
function countConnections(run: () => void): number {
  const originalPrepare = DatabaseSync.prototype.prepare;
  const seen = new Set<unknown>();
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSyncLike,
    ...args: [string]
  ) {
    seen.add(this);
    return originalPrepare.apply(this, args);
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return seen.size;
}

describe('loaders use one connection, not two', () => {
  it('loadAllEntries opens exactly one connection', () => {
    writeEntry(root, createMemory('one entry for the connection count'));
    const count = countConnections(() => {
      loadAllEntries(root, 'default');
    });
    expect(count).toBe(1);
  });

  it('loadAmbientCandidates opens exactly one connection', () => {
    writeEntry(root, createMemory('another entry for the connection count'));
    const count = countConnections(() => {
      loadAmbientCandidates(root, 'default', 5, () => true);
    });
    expect(count).toBe(1);
  });
});

describe('openStore makes the mirror folders once per store', () => {
  it('makes them on the first open only, and again for a store made anew at the same path', () => {
    const mirrorFolders = ['buffer', 'episodic', 'semantic', 'conflicts'];
    const foldersMadeBy = (opens: number): number => {
      const spy = vi.spyOn(fs, 'mkdirSync');
      // The store imports fs by name, and a named import sees the spy only after this sync.
      syncBuiltinESMExports();
      try {
        for (let i = 0; i < opens; i++) closeHippoDb(openStore(root));
        return spy.mock.calls.filter(([dir]) => mirrorFolders.includes(path.basename(String(dir)))).length;
      } finally {
        spy.mockRestore();
        syncBuiltinESMExports();
      }
    };

    // beforeEach's initStore was this store's first open.
    expect(foldersMadeBy(3)).toBe(0);

    fs.rmSync(root, { recursive: true, force: true });
    expect(foldersMadeBy(3)).toBe(mirrorFolders.length);
    expect(mirrorFolders.filter((folder) => fs.existsSync(path.join(root, folder)))).toEqual(mirrorFolders);
  });
});
