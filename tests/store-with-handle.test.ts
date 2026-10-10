// The handle helpers capture code goes through: one call per handle, closed after, even when the call throws.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getMeta, setMeta, type DatabaseSyncLike } from '../src/db/index.js';
import { initStore, withCaptureHandles, withHandle } from '../src/store/open.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-with-handle-'));
  initStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('withHandle', () => {
  it('runs on a handle of its own and keeps what the call wrote', () => {
    withHandle(root, (db) => setMeta(db, 'probe', 'one'), { busyWaitMs: 50 });
    expect(withHandle(root, (db) => getMeta(db, 'probe'))).toBe('one');
  });

  it('closes the handle and rethrows when the call throws', () => {
    let seen: DatabaseSyncLike | undefined;
    expect(() =>
      withHandle(root, (db) => {
        seen = db;
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(() => seen?.prepare('SELECT 1')).toThrow();
  });
});

describe('withCaptureHandles', () => {
  it('gives a dry run the plain handle only', () => {
    withCaptureHandles(root, true, (dryRunDb, writeDb) => {
      expect(dryRunDb).not.toBeNull();
      expect(writeDb).toBeNull();
    });
  });

  it('gives a real write the store handle only, and closes it after', () => {
    let kept: DatabaseSyncLike | null = null;
    withCaptureHandles(root, false, (dryRunDb, writeDb) => {
      expect(dryRunDb).toBeNull();
      expect(writeDb).not.toBeNull();
      kept = writeDb;
    });
    expect(() => kept?.prepare('SELECT 1')).toThrow();
  });
});
