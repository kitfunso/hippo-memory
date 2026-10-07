import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

import { openHippoDb, closeHippoDb } from '../src/db.js';
import {
  apiKeyVerifyStats,
  createApiKey,
  verifyApiKeyCached,
  VerifiedKeyCache,
  VERIFIED_KEY_TTL_MS,
  type CheckedApiKey,
  type VerifiedApiKey,
} from '../src/auth.js';
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

describe('verified API key cache', () => {
  let home: string;
  const verify = (plaintext: string, root: string = home): Promise<VerifiedApiKey | null> =>
    verifyApiKeyCached(root, plaintext, sqliteStore(root));

  function mint(role: 'admin' | 'member' = 'member'): { keyId: string; plaintext: string } {
    const db = openHippoDb(home);
    try {
      return createApiKey(db, { tenantId: 'default', label: 'cache-test', role });
    } finally {
      closeHippoDb(db);
    }
  }

  const adminCtx = (): Context => ({ hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } });

  beforeEach(() => {
    home = makeRoot('key-cache');
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });

  it('verifies a valid key once, then answers from the cache without scrypt or a DB open', async () => {
    const key = mint();
    const first = await counted(() => verify(key.plaintext));
    expect(first.value).toEqual({ tenantId: 'default', keyId: key.keyId, role: 'member', scopes: [] });
    expect(first.scrypt).toBe(1);
    expect(first.dbOpen).toBe(1);

    const second = await counted(() => verify(key.plaintext));
    expect(second.value).toEqual(first.value);
    expect(second.scrypt).toBe(0);
    expect(second.dbOpen).toBe(0);
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

  it('re-reads the store once the TTL has passed, without scrypt for the secret it already proved', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    const key = mint();
    expect((await counted(() => verify(key.plaintext))).scrypt).toBe(1);
    vi.setSystemTime(Date.now() + VERIFIED_KEY_TTL_MS - 1);
    expect(await counted(() => verify(key.plaintext))).toMatchObject({ scrypt: 0, dbOpen: 0 });
    vi.setSystemTime(Date.now() + 2);
    const lapsed = await counted(() => verify(key.plaintext));
    expect(lapsed.value).toEqual({ tenantId: 'default', keyId: key.keyId, role: 'member', scopes: [] });
    expect(lapsed).toMatchObject({ scrypt: 0, dbOpen: 1 });
    expect(await counted(() => verify(key.plaintext))).toMatchObject({ scrypt: 0, dbOpen: 0 });
  });

  it('a lapsed entry never vouches for another secret, and a change made by another process lands on the re-read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    const key = mint();
    const other = mint();
    await verify(key.plaintext);
    await verify(other.plaintext);
    // Straight SQL, as the CLI in another process would write it: the cache hears nothing.
    const db = openHippoDb(home);
    try {
      db.prepare(`INSERT INTO api_key_scope_grants (key_id, scope, granted_at) VALUES (?, ?, ?)`).run(key.keyId, 'slack:private:C9', new Date().toISOString());
      db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE key_id = ?`).run(new Date().toISOString(), other.keyId);
    } finally {
      closeHippoDb(db);
    }
    expect((await verify(key.plaintext))!.scopes).toEqual([]);
    expect(await verify(other.plaintext)).not.toBeNull();
    vi.setSystemTime(Date.now() + VERIFIED_KEY_TTL_MS);
    expect(await counted(() => verify(`${key.keyId}.${'a'.repeat(32)}`))).toMatchObject({ value: null, scrypt: 1 });
    expect(await counted(() => verify(key.plaintext))).toMatchObject({ value: { scopes: ['slack:private:C9'] }, scrypt: 0 });
    expect(await counted(() => verify(other.plaintext))).toMatchObject({ value: null, scrypt: 0 });
  });

  it('calls the scrypt gate only when scrypt is about to run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    const key = mint();
    const revoked = mint();
    authRevoke(adminCtx(), revoked.keyId);
    let gated = 0;
    const gate = (token: string): Promise<VerifiedApiKey | null> => verifyApiKeyCached(home, token, sqliteStore(home), () => { gated++; });
    const gatedBy = async (token: string): Promise<number> => {
      const before = gated;
      await gate(token);
      return gated - before;
    };
    expect(await gatedBy(key.plaintext)).toBe(1);
    expect(await gatedBy(key.plaintext)).toBe(0);
    vi.setSystemTime(Date.now() + VERIFIED_KEY_TTL_MS);
    expect(await gatedBy(key.plaintext)).toBe(0);
    expect(await gatedBy(`${key.keyId}.${'a'.repeat(32)}`)).toBe(1);
    for (const token of ['hk_junk', revoked.plaintext, `hk_${'a'.repeat(24)}.${'b'.repeat(32)}`]) expect(await gatedBy(token), token).toBe(0);
  });

  it('a throw from the scrypt gate refuses before scrypt runs', async () => {
    const key = mint();
    const before = apiKeyVerifyStats().scryptRuns;
    await expect(verifyApiKeyCached(home, key.plaintext, sqliteStore(home), () => { throw new Error('gate shut'); })).rejects.toThrow('gate shut');
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

  it('a lookup that straddles a revoke is not cached, so the next verify reads the store again', async () => {
    const key = mint();
    const inner = sqliteStore(home);
    const racing = { ...inner, findApiKey: async (keyId: string) => {
      const record = await inner.findApiKey(keyId);
      authRevoke(adminCtx(), keyId);
      return record;
    } };
    expect(await verifyApiKeyCached(home, key.plaintext, racing)).not.toBeNull();
    expect(await verify(key.plaintext)).toBeNull();
  });
});

describe('VerifiedKeyCache', () => {
  const key = (id: string): CheckedApiKey => ({ key: { tenantId: 'default', keyId: id, role: 'member', scopes: [] }, expiresAtMs: Infinity, keyHash: `hash-${id}` });

  it('holds at most its capacity, evicting the least recently used key', () => {
    const cache = new VerifiedKeyCache(2, 60_000);
    cache.set('/root', 'hk_a', 'hk_a.s', key('hk_a'), 0);
    cache.set('/root', 'hk_b', 'hk_b.s', key('hk_b'), 0);
    // Touching hk_a makes hk_b the least recent, so hk_c evicts hk_b.
    expect(cache.get('/root', 'hk_a', 'hk_a.s', 1)).not.toBeUndefined();
    cache.set('/root', 'hk_c', 'hk_c.s', key('hk_c'), 1);
    expect(cache.size).toBe(2);
    expect(cache.get('/root', 'hk_b', 'hk_b.s', 1)).toBeUndefined();
    expect(cache.get('/root', 'hk_a', 'hk_a.s', 1)).not.toBeUndefined();
    expect(cache.get('/root', 'hk_c', 'hk_c.s', 1)).not.toBeUndefined();
  });

  it('a wrong secret misses without evicting the verified entry', () => {
    const cache = new VerifiedKeyCache(2, 60_000);
    cache.set('/root', 'hk_a', 'hk_a.s', key('hk_a'), 0);
    expect(cache.get('/root', 'hk_a', 'hk_a.wrong', 1)).toBeUndefined();
    expect(cache.get('/root', 'hk_a', 'hk_a.s', 1)).not.toBeUndefined();
  });

  it('past its TTL an entry misses but still names the hash its exact secret proved, on its own store only', () => {
    const cache = new VerifiedKeyCache(2, 60_000);
    cache.set('/root', 'hk_a', 'hk_a.s', key('hk_a'), 0);
    expect(cache.get('/root', 'hk_a', 'hk_a.s', 60_000)).toBeUndefined();
    expect(cache.verifiedHash('/root', 'hk_a', 'hk_a.s')).toBe('hash-hk_a');
    expect(cache.verifiedHash('/root', 'hk_a', 'hk_a.wrong')).toBeUndefined();
    expect(cache.verifiedHash('/other', 'hk_a', 'hk_a.s')).toBeUndefined();
    cache.delete('hk_a');
    expect(cache.verifiedHash('/root', 'hk_a', 'hk_a.s')).toBeUndefined();
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

  it('a repeat request skips scrypt, and a revoke through the API is a 401 on the very next request', async () => {
    const db = openHippoDb(home);
    let key: { keyId: string; plaintext: string };
    try {
      key = createApiKey(db, { tenantId: 'default', label: 'server-cache', role: 'member' });
    } finally {
      closeHippoDb(db);
    }
    const get = (): Promise<Response> =>
      fetch(`${handle.url}/v1/memories?q=x`, { headers: { authorization: `Bearer ${key.plaintext}` } });

    expect((await get()).status).toBe(200);
    const before = apiKeyVerifyStats();
    expect((await get()).status).toBe(200);
    expect(apiKeyVerifyStats()).toEqual(before);

    const revoked = await fetch(`${handle.url}/v1/auth/keys/${key.keyId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${key.plaintext}` },
    });
    expect(revoked.status).toBe(200);
    expect((await get()).status).toBe(401);
  });
});
