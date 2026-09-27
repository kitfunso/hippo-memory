// initStore + a second openHippoDb was two connections per loader; openStore
// runs init on the one connection the caller keeps. Real SQLite store, no mocks.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'module';
import { initStore, writeEntry, loadAllEntries, loadAmbientCandidates } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import type { DatabaseSyncLike } from '../src/db.js';

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
