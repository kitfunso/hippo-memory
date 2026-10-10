import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OTHER_STORE_MARKER, withUnmigratedDb } from '../src/db/open.js';
import { OtherStoreFolderError } from '../src/util/sqlite-blocked.js';
import { initStore } from '../src/store/open.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-unmigrated-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('withUnmigratedDb', () => {
  it('throws the missing-store message when hippo.db does not exist', () => {
    expect(() => withUnmigratedDb(root, false, () => 1)).toThrow(`No existing Hippo database at ${join(root, 'hippo.db')}`);
  });

  it('refuses a folder with the other-store marker', () => {
    initStore(root);
    writeFileSync(join(root, OTHER_STORE_MARKER), 'postgres');
    expect(() => withUnmigratedDb(root, false, () => 1)).toThrow(OtherStoreFolderError);
  });

  it('refuses a write on a read-only open and allows it on a writable one', () => {
    initStore(root);
    const write = (db: { exec(sql: string): void }) => db.exec('CREATE TABLE probe (x INTEGER)');
    expect(() => withUnmigratedDb(root, true, write)).toThrow(/readonly/i);
    expect(() => withUnmigratedDb(root, false, write)).not.toThrow();
  });
});
