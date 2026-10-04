import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import {
  apiKeyVerifyStats,
  createApiKey,
  verifyApiKeyCached,
  VerifiedKeyCache,
  VERIFIED_KEY_TTL_MS,
  type VerifiedApiKey,
} from '../src/auth.js';
import { authRevoke, authGrant, type Context } from '../src/api.js';
import { serve, type ServerHandle } from '../src/server.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-key-cache-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

/** Scrypt runs and store lookups made by `fn` alone. */
function counted<T>(fn: () => T) {
  const before = apiKeyVerifyStats();
  const value = fn();
  const after = apiKeyVerifyStats();
  return { value, scrypt: after.scryptRuns - before.scryptRuns, dbOpen: after.storeLookups - before.storeLookups };
}

describe('verified API key cache', () => {
  let home: string;

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
    home = makeRoot();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });

  it('verifies a valid key once, then answers from the cache without scrypt or a DB open', () => {
    const key = mint();
    const first = counted(() => verifyApiKeyCached(home, key.plaintext));
    expect(first.value).toEqual({ tenantId: 'default', keyId: key.keyId, role: 'member', scopes: [] });
    expect(first.scrypt).toBe(1);
    expect(first.dbOpen).toBe(1);

    const second = counted(() => verifyApiKeyCached(home, key.plaintext));
    expect(second.value).toEqual(first.value);
    expect(second.scrypt).toBe(0);
    expect(second.dbOpen).toBe(0);
  });

  it('a hit never shares its scopes array with the caller', () => {
    const key = mint();
    verifyApiKeyCached(home, key.plaintext)!.scopes.push('slack:private:leak');
    expect(verifyApiKeyCached(home, key.plaintext)!.scopes).toEqual([]);
  });

  it('an in-process revoke rejects the next verify at once', () => {
    const key = mint();
    expect(verifyApiKeyCached(home, key.plaintext)).not.toBeNull();
    authRevoke(adminCtx(), key.keyId);
    const after = counted(() => verifyApiKeyCached(home, key.plaintext));
    expect(after.value).toBeNull();
    // The row proves the key revoked, so no scrypt is spent on it.
    expect(after.scrypt).toBe(0);
  });

  it('an in-process scope grant shows on the next verify', () => {
    const key = mint();
    expect(verifyApiKeyCached(home, key.plaintext)!.scopes).toEqual([]);
    authGrant(adminCtx(), key.keyId, 'slack:private:C123');
    expect(verifyApiKeyCached(home, key.plaintext)!.scopes).toEqual(['slack:private:C123']);
  });

  it('re-verifies with scrypt once the TTL has passed', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    const key = mint();
    expect(counted(() => verifyApiKeyCached(home, key.plaintext)).scrypt).toBe(1);
    vi.setSystemTime(Date.now() + VERIFIED_KEY_TTL_MS - 1);
    expect(counted(() => verifyApiKeyCached(home, key.plaintext)).scrypt).toBe(0);
    vi.setSystemTime(Date.now() + 2);
    const expired = counted(() => verifyApiKeyCached(home, key.plaintext));
    expect(expired.value).not.toBeNull();
    expect(expired.scrypt).toBe(1);
  });

  it('a wrong secret on a valid key id is rejected and never cached', () => {
    const key = mint();
    const wrong = `${key.keyId}.${'a'.repeat(32)}`;
    for (let i = 0; i < 2; i++) {
      const res = counted(() => verifyApiKeyCached(home, wrong));
      expect(res.value).toBeNull();
      expect(res.scrypt).toBe(1);
    }
    // A cached good key does not let a wrong secret through either.
    verifyApiKeyCached(home, key.plaintext);
    const afterHit = counted(() => verifyApiKeyCached(home, wrong));
    expect(afterHit.value).toBeNull();
    expect(afterHit.scrypt).toBe(1);
    expect(counted(() => verifyApiKeyCached(home, key.plaintext)).scrypt).toBe(0);
  });

  it('rejects malformed tokens and unknown key ids without any scrypt work', () => {
    const malformed = ['no-dot-here', 'hk_forged.secret', `hk_${'a'.repeat(24)}.short`, `HK_${'a'.repeat(24)}.${'b'.repeat(32)}`];
    for (const token of malformed) {
      const res = counted(() => verifyApiKeyCached(home, token));
      expect(res.value).toBeNull();
      expect(res.scrypt).toBe(0);
      expect(res.dbOpen).toBe(0);
    }
    const unknown = counted(() => verifyApiKeyCached(home, `hk_${'a'.repeat(24)}.${'b'.repeat(32)}`));
    expect(unknown.value).toBeNull();
    expect(unknown.scrypt).toBe(0);
  });

  it('a key cached for one store does not authenticate against another', () => {
    const key = mint();
    expect(verifyApiKeyCached(home, key.plaintext)).not.toBeNull();
    const other = makeRoot();
    try {
      expect(verifyApiKeyCached(other, key.plaintext)).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('VerifiedKeyCache', () => {
  const key = (id: string): VerifiedApiKey => ({ tenantId: 'default', keyId: id, role: 'member', scopes: [] });

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
});

describe('bearer requests through the server', () => {
  let home: string;
  let globalHome: string;
  let origHippoHome: string | undefined;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot();
    globalHome = makeRoot();
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
