import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openHippoDb, closeHippoDb, withSharedStoreHandles } from '../src/db.js';
import { initStore } from '../src/store/open.js';

let tmp: string;
let root: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-shared-handles-'));
  root = path.join(tmp, '.hippo');
  initStore(root);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('withSharedStoreHandles', () => {
  it('hands back one open handle per store and closes it when the scope ends', async () => {
    const other = path.join(tmp, 'other');
    initStore(other);
    const seen = await withSharedStoreHandles(() => {
      const a = openHippoDb(root);
      closeHippoDb(a);
      const b = openHippoDb(root);
      const c = openHippoDb(other);
      expect(b).toBe(a);
      expect(a.isOpen).toBe(true);
      expect(c).not.toBe(a);
      return [a, c];
    });
    expect(seen.map((db) => db.isOpen)).toEqual([false, false]);
  });

  it('gives an open nested inside a transaction its own connection', async () => {
    await withSharedStoreHandles(() => {
      const outer = openHippoDb(root);
      outer.exec('BEGIN');
      const inner = openHippoDb(root);
      expect(inner).not.toBe(outer);
      closeHippoDb(inner);
      expect(inner.isOpen).toBe(false);
      outer.exec('ROLLBACK');
      expect(openHippoDb(root)).toBe(outer);
    });
  });

  it('closes the shared handles when the scope throws', async () => {
    let held: ReturnType<typeof openHippoDb> | undefined;
    await expect(withSharedStoreHandles(() => {
      held = openHippoDb(root);
      throw new Error('hook failed');
    })).rejects.toThrow('hook failed');
    expect(held?.isOpen).toBe(false);
  });

  it('opens a fresh handle per call outside a scope', () => {
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
