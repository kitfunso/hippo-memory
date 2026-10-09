import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';

const mode = (p: string): number => statSync(p).mode & 0o777;

let base: string;

afterEach(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Windows has no POSIX mode bits: chmod only toggles read-only, so there is nothing to assert.
describe.skipIf(process.platform === 'win32')('store files are owner-only on create', () => {
  it('a fresh store gets a 0700 directory and 0600 database, WAL and SHM files', () => {
    base = mkdtempSync(join(tmpdir(), 'hippo-perms-'));
    const root = join(base, '.hippo');
    initStore(root);
    const db = openHippoDb(root);
    try {
      expect(mode(root).toString(8)).toBe('700');
      for (const sub of ['buffer', 'episodic', 'semantic', 'conflicts']) {
        expect(mode(join(root, sub)).toString(8), sub).toBe('700');
      }
      for (const file of ['hippo.db', 'hippo.db-wal', 'hippo.db-shm']) {
        expect(mode(join(root, file)).toString(8), file).toBe('600');
      }
    } finally {
      closeHippoDb(db);
    }
  });

  it('never changes the mode of a directory or database that already exists', () => {
    base = mkdtempSync(join(tmpdir(), 'hippo-perms-'));
    const root = join(base, '.hippo');
    mkdirSync(root);
    chmodSync(root, 0o755);
    writeFileSync(join(root, 'hippo.db'), '');
    chmodSync(join(root, 'hippo.db'), 0o644);
    initStore(root);
    expect(mode(root).toString(8)).toBe('755');
    expect(mode(join(root, 'hippo.db')).toString(8)).toBe('644');
  });
});
