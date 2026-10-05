// authCreateSelf mints a signed-in caller its own expiring member key; the member key list and the body-first admin mint are covered beside it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { connect } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { createApiKey, validateApiKey, type CreateApiKeyResult } from '../src/auth.js';
import { listAuditEventsAfter } from '../src/audit.js';
import { adminActor, authCreateSelf, type Actor, type AuthCreateSelfOpts, type AuthCreateSelfResult } from '../src/api.js';
import { ForbiddenError } from '../src/api-errors.js';
import { serve, type AuthResolver, type ResolvedBearer, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';

const TENANT = 'ext-tenant';
const DAY_MS = 86_400_000;
const PEOPLE = new Map<string, ResolvedBearer>([
  ['sso.alice', { tenantId: TENANT, subject: 'alice@corp.example', role: 'member' }],
  ['sso.bob', { tenantId: TENANT, subject: 'bob@corp.example', role: 'member' }],
  ['sso.boss', { tenantId: TENANT, subject: 'boss@corp.example', role: 'admin' }],
]);
const ALICE = 'sso.alice';
const OPTS: AuthCreateSelfOpts = { ttlDays: 90, perSubject: 3 };

let home: string;
let handle: ServerHandle | undefined;

async function start(resolver: AuthResolver = (t) => PEOPLE.get(t) ?? null): Promise<ServerHandle> {
  handle = await serve({ hippoRoot: home, host: '127.0.0.1', port: 0, authResolver: resolver });
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

/** The actor an auth resolver hands core for this token. */
function actorOf(token: string): Actor {
  const person = PEOPLE.get(token)!;
  return { subject: person.subject, role: person.role, viaAuthResolver: true };
}

function mintAs(actor: Actor, label = 'laptop', over: Partial<AuthCreateSelfOpts> = {}): AuthCreateSelfResult {
  return authCreateSelf({ hippoRoot: home, tenantId: TENANT, actor }, { label, ...OPTS, ...over });
}

const selfMint = (token = ALICE, label = 'laptop', over: Partial<AuthCreateSelfOpts> = {}): AuthCreateSelfResult => mintAs(actorOf(token), label, over);

interface KeyRow { key_id: string; owner_subject: string | null; expires_at: string | null; role: string; revoked_at: string | null }

function keyRows(): KeyRow[] {
  // SAFETY: the SELECT names exactly the KeyRow columns.
  return withDb((db) => db.prepare(`SELECT key_id, owner_subject, expires_at, role, revoked_at FROM api_keys WHERE tenant_id = ? ORDER BY id`).all(TENANT) as KeyRow[]);
}

const liveOwned = (owner: string): KeyRow[] => keyRows().filter((r) => r.owner_subject === owner && r.revoked_at === null);

function auditRows(): ReturnType<typeof listAuditEventsAfter> {
  return withDb((db) => listAuditEventsAfter(db, { afterId: 0, tenantId: TENANT }));
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
  rmSync(home, { recursive: true, force: true });
});

describe('authCreateSelf', () => {
  it('mints a member key owned by the caller that expires after ttlDays', () => {
    const before = Date.now();
    const minted = selfMint();
    expect(minted).toMatchObject({ tenantId: TENANT, role: 'member' });
    expect(Date.parse(minted.expiresAt)).toBeGreaterThanOrEqual(before + 90 * DAY_MS);
    expect(Date.parse(minted.expiresAt)).toBeLessThanOrEqual(Date.now() + 90 * DAY_MS);
    expect(keyRows()).toEqual([{ key_id: minted.keyId, owner_subject: 'alice@corp.example', expires_at: minted.expiresAt, role: 'member', revoked_at: null }]);
    expect(withDb((db) => validateApiKey(db, minted.plaintext))).toMatchObject({ valid: true, tenantId: TENANT, role: 'member' });
  });

  it('gives a signed-in admin a member key too', () => {
    const minted = selfMint('sso.boss');
    expect(minted.role).toBe('member');
    expect(keyRows()).toEqual([expect.objectContaining({ role: 'member', owner_subject: 'boss@corp.example' })]);
    expect(withDb((db) => validateApiKey(db, minted.plaintext)).role).toBe('member');
  });

  it.each([
    ['the local CLI', adminActor('cli')],
    ['an admin API key', { subject: 'api_key:hk_admin', role: 'admin' } satisfies Actor],
    ['a member API key', { subject: 'api_key:hk_member', role: 'member' } satisfies Actor],
  ])('refuses %s with ForbiddenError and writes nothing', (_name, actor) => {
    expect(() => mintAs(actor)).toThrow(ForbiddenError);
    expect(keyRows()).toEqual([]);
    expect(auditRows()).toEqual([]);
  });

  it('revokes the oldest live keys over the cap and audits each one with the mint', () => {
    const cap = { perSubject: 2 };
    const first = selfMint(ALICE, 'one', cap);
    const second = selfMint(ALICE, 'two', cap);
    selfMint('sso.bob', 'bob', cap);
    const third = selfMint(ALICE, 'three', cap);
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
    expect(withDb((db) => validateApiKey(db, first.plaintext)).valid).toBe(false);
  });

  it('writes one auth_revoke per replaced key when a lower cap replaces several', () => {
    const early = [selfMint(ALICE, 'a'), selfMint(ALICE, 'b'), selfMint(ALICE, 'c')];
    const latest = selfMint(ALICE, 'd', { perSubject: 1 });
    expect(liveOwned('alice@corp.example').map((r) => r.key_id)).toEqual([latest.keyId]);
    const audit = auditRows();
    expect(audit.filter((r) => r.op === 'auth_revoke')).toEqual(
      early.map((k) => expect.objectContaining({ targetId: k.keyId, metadata: { replacedBy: latest.keyId } })),
    );
    expect(audit.filter((r) => r.op === 'auth_create' && r.targetId === latest.keyId)).toHaveLength(1);
  });

  it.each([
    ['a mint under the cap', 3],
    ['a mint that replaces a key', 1],
  ])('leaves no new key and revokes nothing when the audit write fails: %s', (_name, perSubject) => {
    const kept = selfMint(ALICE, 'kept', { perSubject });
    withDb((db) => db.exec(`CREATE TRIGGER audit_broken BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit table unwritable'); END`));
    expect(() => selfMint(ALICE, 'second', { perSubject })).toThrow(/audit table unwritable/);
    expect(keyRows()).toEqual([expect.objectContaining({ key_id: kept.keyId, revoked_at: null })]);
  });

  it.each([
    ['ttlDays', 0],
    ['ttlDays', -1],
    ['ttlDays', Number.NaN],
    ['ttlDays', Number.POSITIVE_INFINITY],
    ['ttlDays', 3651],
    ['perSubject', 0],
    ['perSubject', 1.5],
    ['perSubject', Number.NaN],
  ])('throws before opening the store when %s is %s', (field, value) => {
    const ctx = { hippoRoot: join(home, 'never-opened'), tenantId: TENANT, actor: actorOf(ALICE) };
    expect(() => authCreateSelf(ctx, { ...OPTS, [field]: value })).toThrow(RangeError);
    expect(() => authCreateSelf(ctx, { ...OPTS, [field]: value })).toThrow(field);
    expect(existsSync(ctx.hippoRoot)).toBe(false);
  });

  it('accepts a fractional day count, the 3650-day ceiling and a cap of one', () => {
    expect(() => selfMint(ALICE, 'half-day', { ttlDays: 0.5 })).not.toThrow();
    const longest = selfMint(ALICE, 'ceiling', { ttlDays: 3650, perSubject: 1 });
    expect(Date.parse(longest.expiresAt)).toBeGreaterThan(Date.now() + 3649 * DAY_MS);
  });
});

describe('POST /v1/auth/keys reads its body before auth', () => {
  it('gives no key to an SSO admin deactivated between headers and body', async () => {
    let active = true;
    let checks = 0;
    await start((t) => {
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
    const a1 = selfMint(ALICE, 'a1');
    const a2 = selfMint(ALICE, 'a2');
    const b1 = selfMint('sso.bob', 'b1');
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
