// Schema v53 gives API keys an owner and an expiry; an expired key fails everywhere, cached or not, and the first expiring key raises the binary floor.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb, getSchemaVersion, type DatabaseSyncLike } from '../src/db.js';
import { raiseMinBinary } from '../src/db/meta.js';
import { createApiKey, readApiKeyRecord, validateApiKey, verifyApiKeyCached, apiKeyVerifyStats, type ApiKeyRecord } from '../src/auth.js';
import { adminActor, authCreateSelf, authList, authListRows, type Actor, type AuthCreateSelfResult } from '../src/api.js';
import { cmdAuth } from '../src/cli/auth.js';
import { serve, type ServerHandle } from '../src/server.js';
import { sqliteStore, type HippoStore } from '../src/store-port.js';
import { EXPIRING_KEYS_MIN_BINARY } from '../src/version.js';
import { makeRoot } from './_helpers/make-root.js';
import { runInProcess } from './_helpers/run-in-process.js';
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

function selfMint(): AuthCreateSelfResult {
  const actor: Actor = { subject: 'alice', role: 'member', viaAuthResolver: true };
  return authCreateSelf({ hippoRoot: home, tenantId: 'default', actor }, { ttlDays: 30, perSubject: 3 });
}

const floor = (): string | undefined => withDb((db) => meta(db, 'min_compatible_binary'));

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

  it('upgrades a v52 store: keys keep working with no owner or expiry, and the binary floor stays', () => {
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
      expect(meta(db, 'min_compatible_binary')).toBe('1.24.0');
      // SAFETY: the SELECT names exactly these two nullable TEXT columns.
      const row = db.prepare(`SELECT owner_subject, expires_at FROM api_keys WHERE key_id = ?`).get(legacy.keyId) as { owner_subject: string | null; expires_at: string | null };
      expect(row).toEqual({ owner_subject: null, expires_at: null });
      expect(validateApiKey(db, legacy.plaintext).valid).toBe(true);
    });
  });

  it('re-runs on a store that already has the columns and leaves the floor where it was', () => {
    withDb((db) => {
      db.prepare(`UPDATE meta SET value = '52' WHERE key = 'schema_version'`).run();
      db.prepare(`UPDATE meta SET value = '0.0.1' WHERE key = 'min_compatible_binary'`).run();
      db.exec('PRAGMA user_version = 52');
    });
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(meta(db, 'min_compatible_binary')).toBe('0.0.1');
    });
  });
});

describe('the binary floor for expiring keys', () => {
  it('a store with no expiring key keeps its old floor, even after a key that never expires', () => {
    withDb((db) => createApiKey(db, { tenantId: 'default', label: 'admin', role: 'admin' }));
    expect(floor()).toBe('1.24.0');
  });

  it('the first self-minted key raises the floor and a second leaves it', () => {
    expect(floor()).toBe('1.24.0');
    selfMint();
    expect(floor()).toBe(EXPIRING_KEYS_MIN_BINARY);
    selfMint();
    expect(floor()).toBe(EXPIRING_KEYS_MIN_BINARY);
  });

  it('a self-mint that fails leaves the floor where it was', () => {
    withDb((db) => db.exec(`CREATE TRIGGER audit_broken BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit table unwritable'); END`));
    expect(() => selfMint()).toThrow(/audit table unwritable/);
    expect(floor()).toBe('1.24.0');
  });

  it('never lowers a higher floor', () => {
    withDb((db) => {
      db.prepare(`UPDATE meta SET value = '9.9.9' WHERE key = 'min_compatible_binary'`).run();
      raiseMinBinary(db, EXPIRING_KEYS_MIN_BINARY);
      expect(meta(db, 'min_compatible_binary')).toBe('9.9.9');
    });
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

  it('treats a store record with no expiresAt field as malformed, not as never expiring', async () => {
    const key = mint(new Date(Date.now() + 60_000).toISOString());
    const { expiresAt: _dropped, ...rest } = withDb((db) => readApiKeyRecord(db, key.keyId))!;
    // SAFETY: a store written against the port before expiresAt existed returns exactly this shape.
    const record = rest as ApiKeyRecord;
    const store: HippoStore = { kind: 'test', findApiKey: async () => record, close: async () => {} };
    expect(await verifyApiKeyCached(home, key.plaintext, store)).toBeNull();
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

interface ListedKeys {
  expired: string;
  live: string;
  liveExpiry: string;
  plain: string;
}

describe('key lists', () => {
  function threeKeys(): ListedKeys {
    const liveExpiry = new Date(Date.now() + 60_000).toISOString();
    const live = mint(liveExpiry).keyId;
    const plain = withDb((db) => createApiKey(db, { tenantId: 'default', label: 'plain', role: 'admin' })).keyId;
    // Minted last, so it sits first in a newest-first page.
    const expired = mint(new Date(Date.now() - 1000).toISOString()).keyId;
    return { expired, live, liveExpiry, plain };
  }

  it('an active list leaves out expired keys, page sizes included, and shows owner and expiry', () => {
    const keys = threeKeys();
    const ctx = { hippoRoot: home, tenantId: 'default', actor: adminActor('cli') };
    expect(authList(ctx, { active: true }).map((k) => k.keyId)).toEqual([keys.plain, keys.live]);
    expect(authList(ctx, { active: false }).map((k) => k.keyId)).toEqual([keys.expired, keys.plain, keys.live]);
    const [first] = authListRows(ctx, { active: true, limit: 1 });
    expect(first?.key.keyId).toBe(keys.plain);
    const byId = new Map(authList(ctx, { active: true }).map((k) => [k.keyId, k]));
    expect(byId.get(keys.live)).toMatchObject({ ownerSubject: 'alice', expiresAt: keys.liveExpiry });
    expect(byId.get(keys.plain)).toMatchObject({ ownerSubject: null, expiresAt: null });
  });

  it('hippo auth list prints each expiry and leaves out expired keys unless --all', async () => {
    const keys = threeKeys();
    const active = await runInProcess(() => cmdAuth(home, ['list'], {}));
    expect(active.stdout).toContain('created  expires  revoked');
    expect(active.stdout).toContain(keys.liveExpiry);
    expect(active.stdout).not.toContain(keys.expired);
    expect((await runInProcess(() => cmdAuth(home, ['list'], { all: true }))).stdout).toContain(keys.expired);
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
