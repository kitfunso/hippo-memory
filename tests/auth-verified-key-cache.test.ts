import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';

import { openHippoDb, closeHippoDb } from '../src/db.js';
import {
  apiKeyVerifyStats,
  createApiKey,
  verifyApiKeyCached,
  VerifiedKeyCache,
  type VerifiedApiKey,
} from '../src/store/auth.js';
import { authRevoke, authGrant, type Context } from '../src/api.js';
import { serve, type ServerHandle } from '../src/server.js';
import { sqliteStore } from '../src/store-port.js';
import { makeRoot } from './_helpers/make-root.js';

/** Scrypt runs and store lookups made by `fn` alone. */
async function counted<T>(fn: () => Promise<T>) {
  const before = apiKeyVerifyStats();
  const value = await fn();
  const after = apiKeyVerifyStats();
  return { value, scrypt: after.scryptRuns - before.scryptRuns, dbOpen: after.storeLookups - before.storeLookups };
}

/** Runs `work` on the store's file directly, as the CLI in another process would: nothing in this process hears of it. */
function onDb<T>(root: string, work: (db: ReturnType<typeof openHippoDb>) => T): T {
  const db = openHippoDb(root);
  try {
    return work(db);
  } finally {
    closeHippoDb(db);
  }
}

describe('verified API key cache', () => {
  let home: string;
  const verify = (plaintext: string, root: string = home): Promise<VerifiedApiKey | null> =>
    verifyApiKeyCached(plaintext, sqliteStore(root));

  const mint = (role: 'admin' | 'member' = 'member'): { keyId: string; plaintext: string } =>
    onDb(home, (db) => createApiKey(db, { tenantId: 'default', label: 'cache-test', role }));

  const adminCtx = (): Context => ({ hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } });

  beforeEach(() => {
    home = makeRoot('key-cache');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('runs scrypt for a valid key once, then reads only the key row on a repeat', async () => {
    const key = mint();
    const first = await counted(() => verify(key.plaintext));
    expect(first.value).toEqual({ tenantId: 'default', keyId: key.keyId, role: 'member', scopes: [] });
    expect(first.scrypt).toBe(1);
    expect(first.dbOpen).toBe(1);

    const second = await counted(() => verify(key.plaintext));
    expect(second.value).toEqual(first.value);
    expect(second.scrypt).toBe(0);
    expect(second.dbOpen).toBe(1);
  });

  it('a hit never shares its scopes array with the caller', async () => {
    const key = mint();
    (await verify(key.plaintext))!.scopes.push('slack:private:leak');
    expect((await verify(key.plaintext))!.scopes).toEqual([]);
  });

  it('an in-process revoke rejects the next verify at once', async () => {
    const key = mint();
    expect(await verify(key.plaintext)).not.toBeNull();
    authRevoke(adminCtx(), key.keyId);
    const after = await counted(() => verify(key.plaintext));
    expect(after.value).toBeNull();
    // The row proves the key revoked, so no scrypt is spent on it.
    expect(after.scrypt).toBe(0);
  });

  it('an in-process scope grant shows on the next verify', async () => {
    const key = mint();
    expect((await verify(key.plaintext))!.scopes).toEqual([]);
    authGrant(adminCtx(), key.keyId, 'slack:private:C123');
    expect((await verify(key.plaintext))!.scopes).toEqual(['slack:private:C123']);
  });

  it('a grant, a role change and a revoke written by another process land on the next verify, with no scrypt', async () => {
    const key = mint();
    const other = mint();
    await verify(key.plaintext);
    await verify(other.plaintext);
    onDb(home, (db) => {
      db.prepare(`INSERT INTO api_key_scope_grants (key_id, scope, granted_at) VALUES (?, ?, ?)`).run(key.keyId, 'slack:private:C9', new Date().toISOString());
      db.prepare(`UPDATE api_keys SET role = 'admin' WHERE key_id = ?`).run(key.keyId);
      db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE key_id = ?`).run(new Date().toISOString(), other.keyId);
    });
    expect(await counted(() => verify(key.plaintext))).toMatchObject({ value: { role: 'admin', scopes: ['slack:private:C9'] }, scrypt: 0 });
    expect(await counted(() => verify(other.plaintext))).toMatchObject({ value: null, scrypt: 0 });
  });

  it('a proved token is checked again once its key row holds another hash', async () => {
    const key = mint();
    const other = mint();
    expect(await verify(key.plaintext)).not.toBeNull();
    onDb(home, (db) => {
      db.prepare(`UPDATE api_keys SET key_hash = (SELECT key_hash FROM api_keys WHERE key_id = ?) WHERE key_id = ?`).run(other.keyId, key.keyId);
    });
    expect(await counted(() => verify(key.plaintext))).toMatchObject({ value: null, scrypt: 1 });
  });

  it('three checks of one unproved key at once share one derivation and one call to the bound', async () => {
    const key = mint();
    const bounded: string[] = [];
    const check = (): Promise<VerifiedApiKey | null> =>
      verifyApiKeyCached(key.plaintext, sqliteStore(home), (keyId, derive) => {
        bounded.push(keyId);
        return derive();
      });
    const burst = await counted(() => Promise.all([check(), check(), check()]));
    expect(burst.value.map((found) => found?.keyId)).toEqual([key.keyId, key.keyId, key.keyId]);
    expect({ scrypt: burst.scrypt, bounded }).toEqual({ scrypt: 1, bounded: [key.keyId] });
  });

  it('calls the bound, with the key id, only when scrypt is about to run', async () => {
    const key = mint();
    const revoked = mint();
    authRevoke(adminCtx(), revoked.keyId);
    const bounded: string[] = [];
    const boundedBy = async (token: string): Promise<string[]> => {
      const before = bounded.length;
      await verifyApiKeyCached(token, sqliteStore(home), (keyId, derive) => {
        bounded.push(keyId);
        return derive();
      });
      return bounded.slice(before);
    };
    expect(await boundedBy(key.plaintext)).toEqual([key.keyId]);
    expect(await boundedBy(key.plaintext)).toEqual([]);
    expect(await boundedBy(`${key.keyId}.${'a'.repeat(32)}`)).toEqual([key.keyId]);
    for (const token of ['hk_junk', revoked.plaintext, `hk_${'a'.repeat(24)}.${'b'.repeat(32)}`]) expect(await boundedBy(token), token).toEqual([]);
  });

  it('a throw from the bound refuses before scrypt runs, and the next check derives as if it never happened', async () => {
    const key = mint();
    const before = apiKeyVerifyStats().scryptRuns;
    await expect(verifyApiKeyCached(key.plaintext, sqliteStore(home), () => { throw new Error('gate shut'); })).rejects.toThrow('gate shut');
    await expect(verifyApiKeyCached(key.plaintext, sqliteStore(home), async () => { throw new Error('queue full'); })).rejects.toThrow('queue full');
    expect(apiKeyVerifyStats().scryptRuns).toBe(before);
    expect(await counted(() => verify(key.plaintext))).toMatchObject({ scrypt: 1 });
  });

  it('a wrong secret on a valid key id is rejected and never cached', async () => {
    const key = mint();
    const wrong = `${key.keyId}.${'a'.repeat(32)}`;
    for (let i = 0; i < 2; i++) {
      const res = await counted(() => verify(wrong));
      expect(res.value).toBeNull();
      expect(res.scrypt).toBe(1);
    }
    // A cached good key does not let a wrong secret through either.
    await verify(key.plaintext);
    const afterHit = await counted(() => verify(wrong));
    expect(afterHit.value).toBeNull();
    expect(afterHit.scrypt).toBe(1);
    expect((await counted(() => verify(key.plaintext))).scrypt).toBe(0);
  });

  it('rejects malformed tokens and unknown key ids without any scrypt work', async () => {
    const malformed = ['no-dot-here', 'hk_forged.secret', `hk_${'a'.repeat(24)}.short`, `HK_${'a'.repeat(24)}.${'b'.repeat(32)}`];
    for (const token of malformed) {
      const res = await counted(() => verify(token));
      expect(res.value).toBeNull();
      expect(res.scrypt).toBe(0);
      expect(res.dbOpen).toBe(0);
    }
    const unknown = await counted(() => verify(`hk_${'a'.repeat(24)}.${'b'.repeat(32)}`));
    expect(unknown.value).toBeNull();
    expect(unknown.scrypt).toBe(0);
  });

  it('a key cached for one store does not authenticate against another', async () => {
    const key = mint();
    expect(await verify(key.plaintext)).not.toBeNull();
    const other = makeRoot('key-cache');
    try {
      expect(await verify(key.plaintext, other)).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('a check whose row was read before a revoke passes that once, and the next verify reads the revoke', async () => {
    const key = mint();
    const inner = sqliteStore(home);
    const racing = { ...inner, findApiKey: async (keyId: string) => {
      const record = await inner.findApiKey(keyId);
      authRevoke(adminCtx(), keyId);
      return record;
    } };
    expect(await verifyApiKeyCached(key.plaintext, racing)).not.toBeNull();
    expect(await verify(key.plaintext)).toBeNull();
  });
});

describe('VerifiedKeyCache', () => {
  it('holds at most its capacity, evicting the least recently used hash', () => {
    const cache = new VerifiedKeyCache(2);
    cache.add('hash-a', 'hk_a.s');
    cache.add('hash-b', 'hk_b.s');
    // Touching hash-a makes hash-b the least recent, so hash-c evicts hash-b.
    expect(cache.has('hash-a', 'hk_a.s')).toBe(true);
    cache.add('hash-c', 'hk_c.s');
    expect(cache.size).toBe(2);
    expect([cache.has('hash-b', 'hk_b.s'), cache.has('hash-a', 'hk_a.s'), cache.has('hash-c', 'hk_c.s')]).toEqual([false, true, true]);
  });

  it('a wrong secret misses without evicting the proved one', () => {
    const cache = new VerifiedKeyCache(2);
    cache.add('hash-a', 'hk_a.s');
    expect(cache.has('hash-a', 'hk_a.wrong')).toBe(false);
    expect(cache.has('hash-a', 'hk_a.s')).toBe(true);
  });
});

describe('bearer requests through the server', () => {
  let home: string;
  let globalHome: string;
  let origHippoHome: string | undefined;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot('key-cache');
    globalHome = makeRoot('key-cache');
    origHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    if (origHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = origHippoHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  const mint = (role: 'admin' | 'member'): { keyId: string; plaintext: string } =>
    onDb(home, (db) => createApiKey(db, { tenantId: 'default', label: 'server-cache', role }));

  async function get(path: string, key: { plaintext: string }): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${handle.url}${path}`, { headers: { authorization: `Bearer ${key.plaintext}` } });
    return { status: res.status, body: await res.json() };
  }

  it('a repeat request skips scrypt, and a revoke through the API is a 401 on the very next request', async () => {
    const key = mint('member');
    expect((await get('/v1/memories?q=x', key)).status).toBe(200);
    const before = apiKeyVerifyStats().scryptRuns;
    expect((await get('/v1/memories?q=x', key)).status).toBe(200);
    expect(apiKeyVerifyStats().scryptRuns).toBe(before);

    const revoked = await fetch(`${handle.url}/v1/auth/keys/${key.keyId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${key.plaintext}` },
    });
    expect(revoked.status).toBe(200);
    expect((await get('/v1/memories?q=x', key)).status).toBe(401);
  });

  it('a revoke written by another process is a 401 on the very next request', async () => {
    const key = mint('member');
    expect((await get('/v1/memories?q=x', key)).status).toBe(200);
    onDb(home, (db) => db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE key_id = ?`).run(new Date().toISOString(), key.keyId));
    expect(await get('/v1/memories?q=x', key)).toEqual({ status: 401, body: { error: 'invalid api key' } });
  });

  it('a role change written by another process decides the very next request, either way', async () => {
    const key = mint('admin');
    const setRole = (role: 'admin' | 'member'): void => {
      onDb(home, (db) => db.prepare(`UPDATE api_keys SET role = ? WHERE key_id = ?`).run(role, key.keyId));
    };
    expect((await get('/v1/quarantine', key)).status).toBe(200);
    setRole('member');
    expect(await get('/v1/quarantine', key)).toEqual({ status: 403, body: { error: '/v1/quarantine requires admin role' } });
    setRole('admin');
    expect((await get('/v1/quarantine', key)).status).toBe(200);
  });

  it('an expiry written by another process is a 401 on the very next request', async () => {
    const key = mint('member');
    expect((await get('/v1/memories?q=x', key)).status).toBe(200);
    onDb(home, (db) => db.prepare(`UPDATE api_keys SET expires_at = ? WHERE key_id = ?`).run('2020-01-01T00:00:00.000Z', key.keyId));
    expect((await get('/v1/memories?q=x', key)).status).toBe(401);
  });
});
