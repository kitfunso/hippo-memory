// A hippo.db grant is a capability: only the SQLite adapter mints one, a look-alike opens nothing,
// and the server thread's part of a worker store refuses every open.
import { describe, expect, it } from 'vitest';
import { DbGrant } from '../../src/db/grant.js';
import { closeHippoDb } from '../../src/db/index.js';
import { SqliteBlockedError } from '../../src/db/sqlite-blocked.js';
import { grantFor } from '../../src/store/sqlite/runtime/grant.js';
import { makeRoot } from '../_helpers/make-root.js';

const NO_GRANT = 'hippo.db opens need a grant from the SQLite adapter';
const SCOPE = { runtime: undefined, session: undefined, workerOnly: false };

describe('DbGrant', () => {
  it('cannot be made without the adapter', () => {
    expect(() => new DbGrant(Symbol('hippo.db grant'), SCOPE)).toThrow(NO_GRANT);
  });

  it('opens nothing for an object that only shares its prototype', () => {
    const root = makeRoot('db-grant-forged');
    const forged: DbGrant = Object.create(DbGrant.prototype);
    expect(() => forged.open(root)).toThrow(NO_GRANT);
    expect(() => forged.openReadOnly(root)).toThrow(NO_GRANT);
    expect(() => forged.withUnmigrated(root, true, () => 1)).toThrow(NO_GRANT);
  });

  it("refuses every open on a worker store's server-thread part", () => {
    const root = makeRoot('db-grant-worker-only');
    const fenced = grantFor({ workerOnly: true });
    expect(() => fenced.open(root)).toThrow(SqliteBlockedError);
    expect(() => fenced.openReadOnly(root)).toThrow(SqliteBlockedError);
    expect(() => fenced.withUnmigrated(root, true, () => 1)).toThrow(SqliteBlockedError);
  });

  it("opens the store on the adapter's own grant", () => {
    const root = makeRoot('db-grant-minted');
    const db = grantFor({}).open(root);
    try {
      expect(db.prepare('SELECT 1 AS x').get()).toEqual({ x: 1 });
    } finally {
      closeHippoDb(db);
    }
  });
});
