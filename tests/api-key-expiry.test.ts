// Schema v53 gives API keys an owner and an expiry; an expired key fails everywhere, cached or not, and older binaries refuse the store.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb, getSchemaVersion, IncompatibleBinaryError, type DatabaseSyncLike } from '../src/db.js';
import { createApiKey, validateApiKey, verifyApiKeyCached, apiKeyVerifyStats } from '../src/auth.js';
import { serve, type ServerHandle } from '../src/server.js';
import { sqliteStore } from '../src/store-port.js';
import { PACKAGE_VERSION } from '../src/version.js';
import { makeRoot } from './_helpers/make-root.js';
import { LATEST_SCHEMA_VERSION } from './_helpers/schema-version.js';

let home: string;

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(home);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function meta(db: DatabaseSyncLike, key: string): string | undefined {
  // SAFETY: the meta table's value column is TEXT; one row by primary key.
  return (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value?: string } | undefined)?.value;
}

function mint(expiresAt?: string): { keyId: string; plaintext: string } {
  return withDb((db) => createApiKey(db, { tenantId: 'default', label: 'expiry', role: 'member', ownerSubject: 'alice', expiresAt }));
}

/** One patch above `v`. */
function nextPatch(v: string): string {
  const [major = 0, minor = 0, patch = 0] = v.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

beforeEach(() => {
  home = makeRoot('key-expiry');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

describe('schema v53', () => {
  it('a fresh store has the owner and expiry columns and the live-owner partial index', () => {
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      // SAFETY: pragma_table_info rows carry a TEXT `name` column.
      const cols = (db.prepare(`SELECT name FROM pragma_table_info('api_keys')`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(['owner_subject', 'expires_at']));
      // SAFETY: one TEXT `sql` column.
      const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_api_keys_live_owner'`).get() as { sql: string };
      expect(idx.sql).toMatch(/\(tenant_id, owner_subject\) WHERE revoked_at IS NULL/);
    });
  });

  it('upgrades a v52 store: keys keep working with no owner or expiry, and the binary floor rises', () => {
    const legacy = withDb((db) => {
      const key = createApiKey(db, { tenantId: 'default', label: 'pre-v53', role: 'admin' });
      db.exec('DROP INDEX idx_api_keys_live_owner');
      db.exec('ALTER TABLE api_keys DROP COLUMN owner_subject');
      db.exec('ALTER TABLE api_keys DROP COLUMN expires_at');
      db.prepare(`UPDATE meta SET value = '52' WHERE key = 'schema_version'`).run();
      db.prepare(`UPDATE meta SET value = '1.24.0' WHERE key = 'min_compatible_binary'`).run();
      db.exec('PRAGMA user_version = 52');
      return key;
    });
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(meta(db, 'min_compatible_binary')).toBe(PACKAGE_VERSION);
      // SAFETY: the SELECT names exactly these two nullable TEXT columns.
      const row = db.prepare(`SELECT owner_subject, expires_at FROM api_keys WHERE key_id = ?`).get(legacy.keyId) as { owner_subject: string | null; expires_at: string | null };
      expect(row).toEqual({ owner_subject: null, expires_at: null });
      expect(validateApiKey(db, legacy.plaintext).valid).toBe(true);
    });
  });

  it('re-runs on a store that already has the columns and still raises the floor', () => {
    withDb((db) => {
      db.prepare(`UPDATE meta SET value = '52' WHERE key = 'schema_version'`).run();
      db.prepare(`UPDATE meta SET value = '0.0.1' WHERE key = 'min_compatible_binary'`).run();
      db.exec('PRAGMA user_version = 52');
    });
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(meta(db, 'min_compatible_binary')).toBe(PACKAGE_VERSION);
    });
  });

  it('an older binary refuses a v53 store', () => {
    withDb((db) => expect(meta(db, 'min_compatible_binary')).toBe(PACKAGE_VERSION));
    // The guard compares floor to binary, so a floor one patch above this binary is how a v53 store looks to the release before it.
    withDb((db) => db.prepare(`UPDATE meta SET value = ? WHERE key = 'min_compatible_binary'`).run(nextPatch(PACKAGE_VERSION)));
    expect(() => openHippoDb(home)).toThrow(IncompatibleBinaryError);
  });
});

describe('API key expiry', () => {
  it('rejects an expired key and accepts one that has not expired', async () => {
    const expired = mint(new Date(Date.now() - 1000).toISOString());
    const live = mint(new Date(Date.now() + 60_000).toISOString());
    withDb((db) => {
      expect(validateApiKey(db, expired.plaintext)).toEqual({ valid: false });
      expect(validateApiKey(db, live.plaintext).valid).toBe(true);
    });
    expect(await verifyApiKeyCached(home, expired.plaintext, sqliteStore(home))).toBeNull();
    expect(await verifyApiKeyCached(home, live.plaintext, sqliteStore(home))).not.toBeNull();
  });

  it('treats an unparseable expiry as expired', () => {
    const key = mint(new Date(Date.now() + 60_000).toISOString());
    withDb((db) => {
      db.prepare(`UPDATE api_keys SET expires_at = 'soon' WHERE key_id = ?`).run(key.keyId);
      expect(validateApiKey(db, key.plaintext).valid).toBe(false);
    });
  });

  it('a cached key stops at its expiry, not a cache TTL later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
    const store = sqliteStore(home);
    const key = mint(new Date(Date.now() + 10_000).toISOString());
    expect(await verifyApiKeyCached(home, key.plaintext, store)).not.toBeNull();
    vi.setSystemTime(Date.now() + 9_999);
    const before = apiKeyVerifyStats();
    expect(await verifyApiKeyCached(home, key.plaintext, store)).not.toBeNull();
    expect(apiKeyVerifyStats().storeLookups).toBe(before.storeLookups);
    vi.setSystemTime(Date.now() + 1);
    expect(await verifyApiKeyCached(home, key.plaintext, store)).toBeNull();
  });
});

describe('expired keys over MCP and the stream', () => {
  let handle: ServerHandle;
  const savedHeartbeat = process.env.MCP_SSE_HEARTBEAT_MS;

  afterEach(async () => {
    await handle.stop();
    if (savedHeartbeat === undefined) delete process.env.MCP_SSE_HEARTBEAT_MS;
    else process.env.MCP_SSE_HEARTBEAT_MS = savedHeartbeat;
  });

  it('refuses an expired key on POST /mcp and GET /mcp/stream', async () => {
    handle = await serve({ hippoRoot: home, port: 0 });
    const key = mint(new Date(Date.now() - 1000).toISOString());
    const headers = { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' };
    const rpc = await fetch(`${handle.url}/mcp`, { method: 'POST', headers, body: '{"jsonrpc":"2.0","method":"tools/list","id":1}' });
    expect(rpc.status).toBe(401);
    const stream = await fetch(`${handle.url}/mcp/stream`, { headers: { ...headers, accept: 'text/event-stream' } });
    expect(stream.status).toBe(401);
  });

  it('closes an open stream once its key expires', async () => {
    process.env.MCP_SSE_HEARTBEAT_MS = '100';
    handle = await serve({ hippoRoot: home, port: 0 });
    const key = mint(new Date(Date.now() + 1500).toISOString());
    const ac = new AbortController();
    const res = await fetch(`${handle.url}/mcp/stream`, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${key.plaintext}` },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !buf.includes('auth_revoked')) {
      const r = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((ok) => setTimeout(() => ok({ value: undefined, done: true }), 300)),
      ]);
      if (r.value) buf += decoder.decode(r.value);
    }
    ac.abort();
    expect(buf).toContain('auth_revoked');
  }, 10_000);
});
