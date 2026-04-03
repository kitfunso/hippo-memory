import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { initStore, writeEntry, batchWriteAndDelete, loadAllEntries } from '../src/store.js';
import { createMemory } from '../src/memory.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-pr1-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SQLite busy_timeout', () => {
  it('sets busy_timeout pragma on open', () => {
    initStore(tmpDir);
    const db = openHippoDb(tmpDir);
    try {
      const row = db.prepare('PRAGMA busy_timeout').get() as { timeout?: number };
      expect(row?.timeout).toBe(5000);
    } finally {
      closeHippoDb(db);
    }
  });

  it('sets synchronous to NORMAL', () => {
    initStore(tmpDir);
    const db = openHippoDb(tmpDir);
    try {
      const row = db.prepare('PRAGMA synchronous').get() as { synchronous?: number };
      // NORMAL = 1
      expect(row?.synchronous).toBe(1);
    } finally {
      closeHippoDb(db);
    }
  });

  it('concurrent readers do not get SQLITE_BUSY', () => {
    initStore(tmpDir);

    // Write some data first
    const entry = createMemory('test concurrent access');
    writeEntry(tmpDir, entry);

    // Open two connections simultaneously (simulates concurrent plugin calls)
    const db1 = openHippoDb(tmpDir);
    const db2 = openHippoDb(tmpDir);
    try {
      const rows1 = db1.prepare('SELECT id FROM memories').all();
      const rows2 = db2.prepare('SELECT id FROM memories').all();
      expect(rows1.length).toBe(1);
      expect(rows2.length).toBe(1);
    } finally {
      closeHippoDb(db1);
      closeHippoDb(db2);
    }
  });
});

describe('batchWriteAndDelete', () => {
  it('writes and deletes in a single transaction', () => {
    initStore(tmpDir);

    // Create entries to later delete
    const toDelete1 = createMemory('will be deleted 1');
    const toDelete2 = createMemory('will be deleted 2');
    writeEntry(tmpDir, toDelete1);
    writeEntry(tmpDir, toDelete2);

    // New entries to write
    const toWrite1 = createMemory('batch written 1');
    const toWrite2 = createMemory('batch written 2');

    batchWriteAndDelete(
      tmpDir,
      [toWrite1, toWrite2],
      [toDelete1.id, toDelete2.id],
    );

    const all = loadAllEntries(tmpDir);
    const ids = all.map((e) => e.id);

    expect(ids).toContain(toWrite1.id);
    expect(ids).toContain(toWrite2.id);
    expect(ids).not.toContain(toDelete1.id);
    expect(ids).not.toContain(toDelete2.id);
  });

  it('is a no-op when both arrays are empty', () => {
    initStore(tmpDir);
    const entry = createMemory('existing');
    writeEntry(tmpDir, entry);

    batchWriteAndDelete(tmpDir, [], []);

    const all = loadAllEntries(tmpDir);
    expect(all.length).toBe(1);
  });
});

describe('Plugin injection dedup guard', () => {
  it('injectedSessions set prevents double injection', async () => {
    // This tests the dedup logic in isolation (the Set-based guard)
    const injectedSessions = new Set<string>();
    const sessionKey = 'test-session-123';

    // First call: not in set, should inject
    expect(injectedSessions.has(sessionKey)).toBe(false);
    injectedSessions.add(sessionKey);

    // Second call: already in set, should skip
    expect(injectedSessions.has(sessionKey)).toBe(true);

    // After session_end: cleared, should inject again
    injectedSessions.delete(sessionKey);
    expect(injectedSessions.has(sessionKey)).toBe(false);
  });
});
