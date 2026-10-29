import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';
import { insertApiKey } from '../../src/store/sqlite/keys/auth.js';
import { KeyVerifier } from '../../src/surface/server/api-key.js';
import { mintApiKey } from '../../src/base/scope/api-key.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { scryptRuns } from '../_helpers/scrypt-count.js';
import { removeDir } from '../_helpers/remove-dir.js';

// One server's key checks, as boot makes them.
const keys = new KeyVerifier();

describe('api key scrypt parameters', () => {
  let root: string;
  let db: DatabaseSyncLike;
  let store: ReturnType<typeof sqliteStore>;
  beforeEach(() => {
    root = makeRoot('scrypt-params');
    db = openHippoDb(root);
    store = sqliteStore(root);
  });
  afterEach(() => {
    closeHippoDb(db);
    removeDir(root);
  });

  function seed(keyHash: string, keyId: string): void {
    insertApiKey(db, {
      keyId,
      keyHash,
      tenantId: 'default',
      label: null,
      role: 'member',
      createdAt: new Date().toISOString(),
      ownerSubject: null,
      expiresAt: null,
    });
  }

  it('mints a six-part hash that round-trips', async () => {
    const minted = mintApiKey();
    expect(minted.keyHash).toMatch(/^scrypt2\$16384\$8\$1\$[0-9a-f]+\$[0-9a-f]+$/);
    seed(minted.keyHash, minted.keyId);
    expect(await keys.verify(minted.plaintext, store)).not.toBeNull();
    expect(await keys.verify(`${minted.plaintext}x`, store)).toBeNull();
  });

  it('still verifies an old three-part hash', async () => {
    const { keyId, plaintext } = mintApiKey();
    const salt = randomBytes(16);
    const old = `scrypt$${salt.toString('hex')}$${scryptSync(plaintext, salt, 32).toString('hex')}`;
    seed(old, keyId);
    expect(await keys.verify(plaintext, store)).not.toBeNull();
  });

  it('rejects an oversized cost without running scrypt', async () => {
    const { keyId, plaintext } = mintApiKey();
    seed(`scrypt2$${2 ** 30}$8$1$${'ab'.repeat(16)}$${'cd'.repeat(32)}`, keyId);
    const before = scryptRuns();
    expect(await keys.verify(plaintext, store)).toBeNull();
    expect(scryptRuns()).toBe(before);
  });

  it('rejects N that is not a power of two, and r or p above their caps', async () => {
    for (const bad of ['16383$8$1', '16384$33$1', '16384$8$17']) {
      const { keyId, plaintext } = mintApiKey();
      seed(`scrypt2$${bad}$${'ab'.repeat(16)}$${'cd'.repeat(32)}`, keyId);
      const before = scryptRuns();
      expect(await keys.verify(plaintext, store)).toBeNull();
      expect(scryptRuns()).toBe(before);
    }
  });
});
