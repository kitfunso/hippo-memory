import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { openHippoDb, type DatabaseSyncLike, closeHippoDb, withSharedStoreHandles } from '../../src/db/index.js';
import { makeStore } from '../_helpers/make-root.js';
import { initTestStore } from '../_helpers/store-template.js';
import { grantFor } from '../../src/store/sqlite/grant.js';

let tmp: string;
let root: string;

beforeEach(() => {
  ({ base: tmp, root } = makeStore('shared-handles'));
});

describe('withSharedStoreHandles', () => {
  it('hands back one open handle per store and closes it when the session ends', async () => {
    const other = path.join(tmp, 'other');
    initTestStore(other);
    const seen = await withSharedStoreHandles((session) => {
      const a = grantFor({ session }).open(root);
      closeHippoDb(a);
      const b = grantFor({ session }).open(root);
      const c = grantFor({ session }).open(other);
      expect(b).toBe(a);
      expect(a.isOpen).toBe(true);
      expect(c).not.toBe(a);
      return [a, c];
    });
    expect(seen.map((db) => db.isOpen)).toEqual([false, false]);
  });

  it('gives an open nested inside a transaction its own connection', async () => {
    await withSharedStoreHandles((session) => {
      const outer = grantFor({ session }).open(root);
      outer.exec('BEGIN');
      const inner = grantFor({ session }).open(root);
      expect(inner).not.toBe(outer);
      closeHippoDb(inner);
      expect(inner.isOpen).toBe(false);
      outer.exec('ROLLBACK');
      expect(grantFor({ session }).open(root)).toBe(outer);
    });
  });

  it('closes the shared handles when the work throws', async () => {
    let held: DatabaseSyncLike | undefined;
    await expect(
      withSharedStoreHandles((session) => {
        held = grantFor({ session }).open(root);
        throw new Error('hook failed');
      }),
    ).rejects.toThrow('hook failed');
    expect(held?.isOpen).toBe(false);
  });

  it('opens a fresh handle per call outside a session', () => {
    const a = openHippoDb(root);
    const b = openHippoDb(root);
    try {
      expect(b).not.toBe(a);
    } finally {
      closeHippoDb(a);
      closeHippoDb(b);
    }
  });
});
