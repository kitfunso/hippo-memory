// No module holds state keyed by a store or a server: each server owns its key checks and local key,
// the scrypt bound is the one process-wide limit, and a store's reopen rides on the store itself.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertApiKey } from '../../src/store/sqlite/keys/auth.js';
import { KeyVerifier } from '../../src/surface/server/api-key.js';
import { issueLocalKey, readLocalKey } from '../../src/surface/server/local-key.js';
import { mintApiKey } from '../../src/base/scope/api-key.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { inSqliteSession, sqliteStore } from '../../src/store/sqlite/store.js';
import { runSqliteRequest } from '../../src/store/sqlite/runtime/request-scope.js';
import { storeForRequest, workerSqliteStore } from '../../src/store/sqlite/runtime/worker-store.js';
import type { HippoStore, CoreGroups } from '../../src/base/ports/store-index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { removeDir } from '../_helpers/remove-dir.js';

let roots: string[] = [];
const root = (name: string): string => {
  const made = makeRoot(name);
  roots.push(made);
  return made;
};

beforeEach(() => {
  roots = [];
});

afterEach(() => {
  for (const made of roots) removeDir(made);
});

function seedKey(hippoRoot: string): string {
  const minted = mintApiKey();
  const db = openHippoDb(hippoRoot);
  try {
    insertApiKey(db, {
      keyId: minted.keyId,
      keyHash: minted.keyHash,
      tenantId: 'default',
      label: null,
      role: 'member',
      createdAt: new Date().toISOString(),
      ownerSubject: null,
      expiresAt: null,
    });
  } finally {
    closeHippoDb(db);
  }
  return minted.plaintext;
}

describe('KeyVerifier', () => {
  it('keeps the tokens it proved apart from another verifier', async () => {
    const hippoRoot = root('key-verifiers');
    const plaintext = seedKey(hippoRoot);
    const store = sqliteStore(hippoRoot);
    let derivations = 0;
    const counted = (_keyId: string, derive: () => Promise<Buffer>): Promise<Buffer> => {
      derivations += 1;
      return derive();
    };
    const first = new KeyVerifier();
    const second = new KeyVerifier();

    expect(await first.verify(plaintext, store, counted)).not.toBeNull();
    expect(await first.verify(plaintext, store, counted)).not.toBeNull();
    expect(derivations).toBe(1);
    expect(await second.verify(plaintext, store, counted)).not.toBeNull();
    expect(derivations).toBe(2);
  });

  it("keeps each address's tries on a key id with its own proofs, so a second server starts with a full budget", () => {
    const first = new KeyVerifier();
    for (let i = 0; i < 5; i++) first.admit('hk_state_tries', '10.0.0.9');
    expect(() => first.admit('hk_state_tries', '10.0.0.9')).toThrow('too many key checks from this address');
    expect(() => new KeyVerifier().admit('hk_state_tries', '10.0.0.9')).not.toThrow();
  });
});

describe('the scrypt bound', () => {
  it('is one for the process: a third derivation waits while two run, whichever verifier started them', async () => {
    const release: (() => void)[] = [];
    const started: string[] = [];
    const held = (keyId: string) => (): Promise<Buffer> =>
      new Promise((resolve) => {
        started.push(keyId);
        release.push(() => resolve(Buffer.alloc(0)));
      });
    const charged = (): void => undefined;
    const [first, second] = [new KeyVerifier(), new KeyVerifier()];
    // Distinct key ids and addresses, so only the process's two-derivation cap can hold the third.
    const one = first.boundFor('10.0.0.1', charged)('hk_state_one', held('hk_state_one'));
    const two = second.boundFor('10.0.0.2', charged)('hk_state_two', held('hk_state_two'));
    const three = first.boundFor('10.0.0.3', charged)('hk_state_three', held('hk_state_three'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(['hk_state_one', 'hk_state_two']);

    release.shift()?.();
    await one;
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(['hk_state_one', 'hk_state_two', 'hk_state_three']);
    for (const done of release.splice(0)) done();
    await Promise.all([two, three]);
  });
});

describe('LocalKey', () => {
  it("is the issuing server's own: another server refuses it", () => {
    const rootA = root('local-key-a');
    const rootB = root('local-key-b');
    const keyA = issueLocalKey(rootA);
    const keyB = issueLocalKey(rootB);
    const tokenA = readLocalKey(rootA)!;

    expect(keyA.matches(tokenA)).toBe(true);
    expect(keyB.matches(tokenA)).toBe(false);
    expect(keyB.matches(readLocalKey(rootB)!)).toBe(true);
  });
});

describe('inSqliteSession', () => {
  it("reopens sqliteStore's own store on a session, and leaves a spread copy as it is", async () => {
    const store = sqliteStore(root('reopen-mark'));
    const copy = { ...store };
    await runSqliteRequest(async (session) => {
      expect(inSqliteSession(store, session)).not.toBe(store);
      expect(inSqliteSession(copy, session)).toBe(copy);
    }, 'cli');
  });
});

// A marker is an own property: a store made with Object.create over a marked one is the caller's, not the marked store.
describe('a store decorated with Object.create', () => {
  it('keeps its methods and groups through storeForRequest when it decorates a worker store', async () => {
    const worker = workerSqliteStore(root('decorated-worker'));
    try {
      const decorated: HippoStore & CoreGroups = Object.create(worker);
      const bound = storeForRequest(decorated, {});
      expect(bound.findApiKey).toBe(worker.findApiKey);
      expect(bound.entryWrites).toBe(worker.entryWrites);
    } finally {
      await worker.close();
    }
  });

  it('keeps its own override through the reopen when it decorates sqliteStore', async () => {
    const decorated: HippoStore & CoreGroups = Object.create(sqliteStore(root('decorated-sqlite')));
    const override: HippoStore['findApiKey'] = async () => null;
    decorated.findApiKey = override;
    await runSqliteRequest(async (session) => {
      const reopened = inSqliteSession(decorated, session);
      expect(reopened.findApiKey).toBe(override);
      expect(reopened).toBe(decorated);
    }, 'cli');
  });
});
