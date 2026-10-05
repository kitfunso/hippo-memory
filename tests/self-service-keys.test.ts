// POST /v1/auth/keys/self mints an SSO caller its own expiring member key; GET /v1/auth/connect tells a client where to sign in.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { connect } from 'node:net';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { createApiKey, type CreateApiKeyResult } from '../src/auth.js';
import { listAuditEventsAfter } from '../src/audit.js';
import { serve, type AuthResolver, type ConnectInfo, type ResolvedBearer, type ServeOpts, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';

const TENANT = 'ext-tenant';
const DAY_MS = 86_400_000;
const PEOPLE = new Map<string, ResolvedBearer>([
  ['sso.alice', { tenantId: TENANT, subject: 'alice@corp.example', role: 'member' }],
  ['sso.bob', { tenantId: TENANT, subject: 'bob@corp.example', role: 'member' }],
  ['sso.boss', { tenantId: TENANT, subject: 'boss@corp.example', role: 'admin' }],
]);
const ALICE = 'sso.alice';

let home: string;
let handle: ServerHandle | undefined;

async function start(extra: Partial<ServeOpts> = {}, resolver: AuthResolver = (t) => PEOPLE.get(t) ?? null): Promise<ServerHandle> {
  handle = await serve({ hippoRoot: home, host: '127.0.0.1', port: 0, authResolver: resolver, selfServiceKeys: { ttlDays: 90, perSubject: 3 }, ...extra });
  return handle;
}

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(home);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function mintDirect(role: 'admin' | 'member'): CreateApiKeyResult {
  return withDb((db) => createApiKey(db, { tenantId: TENANT, label: `direct-${role}`, role }));
}

interface KeyRow { key_id: string; owner_subject: string | null; expires_at: string | null; role: string; revoked_at: string | null }

function keyRows(): KeyRow[] {
  // SAFETY: the SELECT names exactly the KeyRow columns.
  return withDb((db) => db.prepare(`SELECT key_id, owner_subject, expires_at, role, revoked_at FROM api_keys WHERE tenant_id = ? ORDER BY id`).all(TENANT) as KeyRow[]);
}

const liveOwned = (owner: string): KeyRow[] => keyRows().filter((r) => r.owner_subject === owner && r.revoked_at === null);

function auditRows(): ReturnType<typeof listAuditEventsAfter> {
  return withDb((db) => listAuditEventsAfter(db, { afterId: 0, tenantId: TENANT }));
}

function post(path: string, token: string | undefined, body: string): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
  return fetch(`${handle!.url}${path}`, { method: 'POST', headers, body });
}

interface Minted { keyId: string; plaintext: string; tenantId: string; role: string; expiresAt: string }

async function selfMint(token = ALICE, label = 'laptop'): Promise<Minted> {
  const res = await post('/v1/auth/keys/self', token, JSON.stringify({ label }));
  expect(res.status).toBe(200);
  // SAFETY: a 200 from /v1/auth/keys/self returns the minted key record.
  return (await res.json()) as Minted;
}

async function listKeys(token: string): Promise<string[]> {
  const res = await fetch(`${handle!.url}/v1/auth/keys?active=false`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  // SAFETY: GET /v1/auth/keys returns a bare array of key records.
  return ((await res.json()) as Array<{ keyId: string }>).map((k) => k.keyId).sort();
}

/** Sends the headers, runs `between`, then sends the body; resolves with the status code once the server answers. */
function postInTwoParts(path: string, token: string, body: string, between: () => Promise<void>): Promise<number> {
  return new Promise((resolve, reject) => {
    let data = '';
    const socket = connect(handle!.port, '127.0.0.1', () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${handle!.port}\r\nAuthorization: Bearer ${token}\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`,
      );
      between().then(() => socket.write(body), (err: Error) => { socket.destroy(); reject(err); });
    });
    socket.on('data', (chunk) => { data += chunk.toString('utf8'); });
    socket.on('end', () => resolve(Number(data.split(' ')[1])));
    socket.on('error', reject);
  });
}

beforeEach(() => {
  home = makeRoot('self-keys');
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  vi.restoreAllMocks();
  delete process.env.HIPPO_REQUIRE_AUTH;
  rmSync(home, { recursive: true, force: true });
});

describe('POST /v1/auth/keys/self', () => {
  it('is a 404 unless selfServiceKeys is set', async () => {
    await start({ selfServiceKeys: undefined });
    expect((await post('/v1/auth/keys/self', ALICE, '{}')).status).toBe(404);
  });

  it('mints a member key owned by the SSO subject that expires after ttlDays', async () => {
    await start();
    const before = Date.now();
    const minted = await selfMint();
    expect(minted).toMatchObject({ tenantId: TENANT, role: 'member' });
    expect(Date.parse(minted.expiresAt) - before).toBeGreaterThanOrEqual(90 * DAY_MS - 1000);
    expect(Date.parse(minted.expiresAt) - Date.now()).toBeLessThanOrEqual(90 * DAY_MS);
    expect(keyRows()).toEqual([{ key_id: minted.keyId, owner_subject: 'alice@corp.example', expires_at: minted.expiresAt, role: 'member', revoked_at: null }]);
    const used = await fetch(`${handle!.url}/v1/memories?q=x`, { headers: { authorization: `Bearer ${minted.plaintext}` } });
    expect(used.status).toBe(200);
  });

  it('gives an SSO admin a member key too', async () => {
    await start();
    const minted = await selfMint('sso.boss');
    expect(minted.role).toBe('member');
    expect(keyRows()[0]).toMatchObject({ role: 'member', owner_subject: 'boss@corp.example' });
    expect((await post('/v1/sleep', minted.plaintext, '{}')).status).toBe(403);
  });

  it('refuses an API key of either role and the keyless local CLI with 403', async () => {
    await start();
    for (const key of [mintDirect('admin'), mintDirect('member')]) {
      expect((await post('/v1/auth/keys/self', key.plaintext, '{}')).status).toBe(403);
    }
    expect((await post('/v1/auth/keys/self', undefined, '{}')).status).toBe(403);
    expect(keyRows().every((r) => r.owner_subject === null)).toBe(true);
  });

  it.each([
    ['a tenant', '{"tenantId":"other"}'],
    ['a role', '{"role":"admin"}'],
    ['a non-string label', '{"label":7}'],
    ['invalid JSON', '{"label":'],
    ['a JSON array', '["label"]'],
  ])('answers 400 for a body with %s and mints nothing', async (_name, body) => {
    await start();
    expect((await post('/v1/auth/keys/self', ALICE, body)).status).toBe(400);
    expect(keyRows()).toEqual([]);
  });

  it('revokes the oldest live keys over the cap and audits each one with the mint', async () => {
    await start({ selfServiceKeys: { ttlDays: 30, perSubject: 2 } });
    const first = await selfMint(ALICE, 'one');
    const second = await selfMint(ALICE, 'two');
    await selfMint('sso.bob', 'bob');
    const third = await selfMint(ALICE, 'three');
    expect(liveOwned('alice@corp.example').map((r) => r.key_id)).toEqual([second.keyId, third.keyId]);
    expect(liveOwned('bob@corp.example')).toHaveLength(1);
    const audit = auditRows();
    expect(audit.filter((r) => r.op === 'auth_revoke')).toEqual([
      expect.objectContaining({ actor: 'alice@corp.example', targetId: first.keyId, metadata: { replacedBy: third.keyId } }),
    ]);
    expect(audit.find((r) => r.op === 'auth_create' && r.targetId === third.keyId)).toMatchObject({
      actor: 'alice@corp.example',
      metadata: { label: 'three', role: 'member', self: true, expiresAt: third.expiresAt },
    });
    const old = await fetch(`${handle!.url}/v1/memories?q=x`, { headers: { authorization: `Bearer ${first.plaintext}` } });
    expect(old.status).toBe(401);
  });

  it('never leaves more than perSubject live keys under concurrent mints', async () => {
    await start({ selfServiceKeys: { ttlDays: 30, perSubject: 2 } });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => post('/v1/auth/keys/self', ALICE, JSON.stringify({ label: `m${i}` }))));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(liveOwned('alice@corp.example')).toHaveLength(2);
    expect(auditRows().filter((r) => r.op === 'auth_revoke')).toHaveLength(6);
  });

  it.each([
    ['a mint under the cap', 3],
    ['a mint that replaces a key', 1],
  ])('leaves no key and revokes nothing when the audit write fails: %s', async (_name, perSubject) => {
    await start({ selfServiceKeys: { ttlDays: 30, perSubject } });
    const kept = await selfMint();
    withDb((db) => db.exec(`CREATE TRIGGER audit_broken BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit table unwritable'); END`));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect((await post('/v1/auth/keys/self', ALICE, '{"label":"second"}')).status).toBe(500);
    expect(keyRows()).toEqual([expect.objectContaining({ key_id: kept.keyId, revoked_at: null })]);
  });

  it('runs auth after the body arrives, so a user deactivated mid-request gets no key', async () => {
    let active = true;
    let checks = 0;
    await start({}, (t) => {
      if (t !== ALICE) return null;
      checks++;
      return active ? PEOPLE.get(ALICE)! : null;
    });
    const status = await postInTwoParts('/v1/auth/keys/self', ALICE, '{"label":"late"}', async () => {
      await new Promise((ok) => setTimeout(ok, 200));
      expect(checks).toBe(0);
      active = false;
    });
    expect(status).toBe(401);
    expect(keyRows()).toEqual([]);
  });
});

describe('POST /v1/auth/keys reads its body before auth too', () => {
  it('gives no key to an SSO admin deactivated between headers and body', async () => {
    let active = true;
    let checks = 0;
    await start({}, (t) => {
      if (t !== 'sso.boss') return null;
      checks++;
      return active ? PEOPLE.get('sso.boss')! : null;
    });
    const status = await postInTwoParts('/v1/auth/keys', 'sso.boss', '{"label":"handed-out"}', async () => {
      await new Promise((ok) => setTimeout(ok, 200));
      expect(checks).toBe(0);
      active = false;
    });
    expect(status).toBe(401);
    expect(keyRows()).toEqual([]);
  });
});

describe('GET /v1/auth/keys for members', () => {
  it('shows a member only its own keys, and an admin every key in the tenant', async () => {
    await start();
    const a1 = await selfMint(ALICE, 'a1');
    const a2 = await selfMint(ALICE, 'a2');
    const b1 = await selfMint('sso.bob', 'b1');
    const plain = mintDirect('member');
    const admin = mintDirect('admin');
    expect(await listKeys(ALICE)).toEqual([a1.keyId, a2.keyId].sort());
    expect(await listKeys(a1.plaintext)).toEqual([a1.keyId, a2.keyId].sort());
    expect(await listKeys(b1.plaintext)).toEqual([b1.keyId]);
    expect(await listKeys(plain.plaintext)).toEqual([plain.keyId]);
    const all = [a1.keyId, a2.keyId, b1.keyId, plain.keyId, admin.keyId].sort();
    expect(await listKeys('sso.boss')).toEqual(all);
    expect(await listKeys(admin.plaintext)).toEqual(all);
  });
});

describe('GET /v1/auth/connect', () => {
  const INFO: ConnectInfo = {
    issuer: 'https://login.example.com/tenant/v2.0',
    clientId: 'public-client-id',
    scopes: ['openid', 'api://hippo/access'],
    redirectUris: ['http://localhost'],
  };

  it('is a 404 when connectInfo is unset', async () => {
    await start();
    expect((await fetch(`${handle!.url}/v1/auth/connect`)).status).toBe(404);
  });

  it('serves the four connect fields without auth, and nothing else passed in', async () => {
    // SAFETY: a stray field is added on purpose to prove the route drops it.
    await start({ connectInfo: { ...INFO, clientSecret: 'never-served' } as ConnectInfo });
    const res = await fetch(`${handle!.url}/v1/auth/connect`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(INFO);
  });
});

describe('selfServiceKeys config', () => {
  it.each([
    [{ ttlDays: 0, perSubject: 3 }],
    [{ ttlDays: Number.NaN, perSubject: 3 }],
    [{ ttlDays: 90, perSubject: 0 }],
    [{ ttlDays: 90, perSubject: 1.5 }],
  ])('refuses to boot with %j', async (selfServiceKeys) => {
    await expect(serve({ hippoRoot: home, port: 0, selfServiceKeys })).rejects.toThrow(/selfServiceKeys\./);
  });
});
