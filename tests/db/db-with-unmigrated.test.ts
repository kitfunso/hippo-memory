import { beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OTHER_STORE_MARKER } from '../../src/db/open.js';
import { grantFor } from '../../src/store/sqlite/runtime/grant.js';
import { OtherStoreFolderError } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initStore } from '../../src/store/sqlite/runtime/handles.js';

let root: string;
beforeEach(() => {
  root = makeRoot('unmigrated', { init: false });
});

// The adapter's own grant, as audit-maintenance repairs through it.
const grant = grantFor({});

describe('DbGrant.withUnmigrated', () => {
  it('throws the missing-store message when hippo.db does not exist', () => {
    expect(() => grant.withUnmigrated(root, false, () => 1)).toThrow(
      `No existing Hippo database at ${join(root, 'hippo.db')}`,
    );
  });

  it('refuses a folder with the other-store marker', () => {
    initStore(root);
    writeFileSync(join(root, OTHER_STORE_MARKER), 'postgres');
    expect(() => grant.withUnmigrated(root, false, () => 1)).toThrow(OtherStoreFolderError);
  });

  it('refuses a write on a read-only open and allows it on a writable one', () => {
    initStore(root);
    const write = (db: { exec(sql: string): void }) => db.exec('CREATE TABLE probe (x INTEGER)');
    const hasProbe = (): boolean =>
      grant.withUnmigrated(
        root,
        true,
        (db) => db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'probe'").get() !== undefined,
      );
    expect(() => grant.withUnmigrated(root, true, write)).toThrow(/readonly/i);
    expect(hasProbe()).toBe(false);
    grant.withUnmigrated(root, false, write);
    expect(hasProbe()).toBe(true);
  });
});
