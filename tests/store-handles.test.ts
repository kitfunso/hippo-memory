import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, type DatabaseSyncLike, getMeta, runWithRequestStores, setMeta } from '../src/db/index.js';
import { isScopedHandle } from '../src/db/request-stores.js';
import { openReadHandle, openScratchHandle, openWriteHandle, withWriteHandle } from '../src/store/handles.js';
import { makeRoot } from './_helpers/make-root.js';

describe('store handles', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('handles'); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('a write handle writes to the real file', () => {
    const db = openWriteHandle(root, { busyWaitMs: 50 });
    setMeta(db, 'handle_probe', 'one');
    closeHippoDb(db);
    const again = openWriteHandle(root);
    expect(getMeta(again, 'handle_probe', '')).toBe('one');
    closeHippoDb(again);
  });

  it('withWriteHandle returns the result and closes the handle even when the call throws', () => {
    let seen: DatabaseSyncLike | undefined;
    expect(() => withWriteHandle(root, (db) => { seen = db; throw new Error('boom'); })).toThrow('boom');
    expect(() => seen?.exec('SELECT 1')).toThrow();
    expect(withWriteHandle(root, (db) => { setMeta(db, 'handle_probe', 'three'); return getMeta(db, 'handle_probe', ''); })).toBe('three');
  });

  it('a read handle sees committed rows and refuses a write', () => {
    const w = openWriteHandle(root);
    setMeta(w, 'handle_probe', 'two');
    closeHippoDb(w);
    const db = openReadHandle(root);
    try {
      expect(getMeta(db, 'handle_probe', '')).toBe('two');
      expect(() => db.exec(`INSERT INTO meta(key, value) VALUES ('x', 'y')`)).toThrow();
    } finally {
      closeHippoDb(db);
    }
  });

  it('a scratch handle opened inside a request scope is not the scope\'s own handle', async () => {
    await runWithRequestStores(() => {
      const scoped = openWriteHandle(root);
      const scratch = openScratchHandle(root);
      try {
        expect(isScopedHandle(scoped)).toBe(true);
        expect(isScopedHandle(scratch)).toBe(false);
      } finally {
        closeHippoDb(scratch);
        closeHippoDb(scoped);
      }
    });
  });
});
