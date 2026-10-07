// Actor.owner is the person behind a call: an owned key's owner_subject or the resolver's subject, never set by plugin code.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { apiKeyVerifyStats, createApiKey, verifyApiKeyCached, type ApiKeyRecord, type CreateApiKeyResult } from '../src/auth.js';
import { ownerOrSubject, type Actor } from '../src/api.js';
import { ownerOrSubject as exportedOwnerOrSubject, serve, sqliteStore, type AuthResolver, type HippoStore, type ResolvedBearer, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';

const WHOAMI = '/v1/x-whoami';

let home: string;
let handle: ServerHandle | undefined;

interface Whoami { subject: string; owner: string | null; key: string }

async function start(opts: { authResolver?: AuthResolver; store?: HippoStore } = {}): Promise<ServerHandle> {
  handle = await serve({
    hippoRoot: home,
    host: '127.0.0.1',
    port: 0,
    ...opts,
    routes: [{ path: WHOAMI, handler: async ({ ctx }) => ({ subject: ctx.actor.subject, owner: ctx.actor.owner ?? null, key: ownerOrSubject(ctx.actor) }) }],
  });
  return handle;
}

async function whoami(token: string): Promise<Whoami> {
  const res = await fetch(`${handle!.url}${WHOAMI}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(res.status).toBe(200);
  // SAFETY: the WHOAMI handler above returns exactly these three fields.
  return (await res.json()) as Whoami;
}

function mint(ownerSubject?: string): CreateApiKeyResult {
  const db = openHippoDb(home);
  try {
    return createApiKey(db, { tenantId: 'default', label: 'owner-test', role: 'member', ownerSubject });
  } finally {
    closeHippoDb(db);
  }
}

beforeEach(() => {
  home = makeRoot('actor-owner');
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe('Actor.owner', () => {
  it('owned key carries owner', async () => {
    await start();
    const key = mint('alice@corp.example');
    expect(await whoami(key.plaintext)).toEqual({ subject: `api_key:${key.keyId}`, owner: 'alice@corp.example', key: 'alice@corp.example' });
  });

  it('unowned key has no owner, so ownerOrSubject is the key id', async () => {
    await start();
    const key = mint();
    expect(await whoami(key.plaintext)).toEqual({ subject: `api_key:${key.keyId}`, owner: null, key: `api_key:${key.keyId}` });
  });

  it('resolver path owner is the subject', async () => {
    await start({ authResolver: (t) => (t === 'tok.bob' ? { tenantId: 'ext', subject: 'bob@corp.example', role: 'member' } : null) });
    expect(await whoami('tok.bob')).toEqual({ subject: 'bob@corp.example', owner: 'bob@corp.example', key: 'bob@corp.example' });
  });

  it('a resolver cannot set owner: the sanitised identity keeps only the subject', async () => {
    // SAFETY: plugin code is untyped at runtime; the extra field is what a hostile resolver would add.
    const forged = { tenantId: 'ext', subject: 'mallory@corp.example', role: 'member', owner: 'alice@corp.example' } as ResolvedBearer;
    await start({ authResolver: () => forged });
    expect(await whoami('tok.mallory')).toEqual({ subject: 'mallory@corp.example', owner: 'mallory@corp.example', key: 'mallory@corp.example' });
  });

  it('cache hit keeps owner', async () => {
    const key = mint('alice@corp.example');
    const store = sqliteStore(home);
    expect((await verifyApiKeyCached(home, key.plaintext, store))?.ownerSubject).toBe('alice@corp.example');
    const before = apiKeyVerifyStats();
    expect((await verifyApiKeyCached(home, key.plaintext, store))?.ownerSubject).toBe('alice@corp.example');
    expect(apiKeyVerifyStats()).toEqual(before);
  });

  it('store record with no ownerSubject reads as no owner', async () => {
    const key = mint('alice@corp.example');
    const inner = sqliteStore(home);
    // A store written before the field existed omits it; the key must fall back to its own id, not borrow anyone's.
    const legacy: HippoStore = { ...inner, findApiKey: async (id: string): Promise<ApiKeyRecord | null> => {
      const record = await inner.findApiKey(id);
      if (!record) return null;
      const { ownerSubject: _dropped, ...rest } = record;
      return rest;
    } };
    await start({ store: legacy });
    expect(await whoami(key.plaintext)).toEqual({ subject: `api_key:${key.keyId}`, owner: null, key: `api_key:${key.keyId}` });
  });

  it('ownerOrSubject is published on the server subpath', () => {
    const actor: Actor = { subject: 'api_key:hk_x', role: 'member', owner: 'carol' };
    expect(exportedOwnerOrSubject(actor)).toBe('carol');
    expect(exportedOwnerOrSubject({ subject: 'api_key:hk_x', role: 'member' })).toBe('api_key:hk_x');
  });
});
