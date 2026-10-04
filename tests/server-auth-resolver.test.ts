/** serve({ authResolver }) vouches for external bearer tokens; the core sanitises what it returns. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ServerResponse } from 'node:http';
import { initStore, writeEntry } from '../src/store.js';
import { Layer } from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import {
  serve, authRevoke, ForbiddenError, isReservedActor,
  type ServerHandle, type AuthResolver, type ResolvedBearer, type ServeOpts, type Context,
} from '../src/server.js';
import { createApiKey, type CreateApiKeyResult } from '../src/auth.js';
import { openHippoDb, closeHippoDb, getHippoDbPath } from '../src/db.js';
import { listAuditEventsAfter } from '../src/audit.js';

const EXT = 'ext.good';
const GOOD: ResolvedBearer = { tenantId: 'ext-tenant', subject: 'user-1', role: 'member', scopes: [] };
const PRIVATE_SCOPE = 'slack:private:C1';

let home: string;
let handle: ServerHandle | undefined;
let apiKey: CreateApiKeyResult;
const savedEnv = { req: process.env.HIPPO_REQUIRE_AUTH, hb: process.env.MCP_SSE_HEARTBEAT_MS };

async function start(authResolver?: AuthResolver, hippoRoot = home, extra: Partial<ServeOpts> = {}): Promise<ServerHandle> {
  handle = await serve({ hippoRoot, host: '127.0.0.1', port: 0, authResolver, ...extra });
  return handle;
}

function auditRows(tenantId: string): ReturnType<typeof listAuditEventsAfter> {
  const db = openHippoDb(home);
  try {
    return listAuditEventsAfter(db, { afterId: 0, tenantId });
  } finally {
    closeHippoDb(db);
  }
}

function openStream(token: string, signal: AbortSignal): Promise<Response> {
  return fetch(`${handle!.url}/mcp/stream`, {
    headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` },
    signal,
  });
}

function collect(res: Response): () => string {
  let buf = '';
  const decoder = new TextDecoder();
  const reader = res.body!.getReader();
  void (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        buf += decoder.decode(r.value);
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) throw err;
    }
  })();
  return () => buf;
}

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((ok) => setTimeout(ok, 20));
}

type Loose = Partial<Record<keyof ResolvedBearer, string | Array<string | number | null>>>;
// SAFETY: tests pass deliberately malformed fields to prove the core rejects or downgrades them.
const tokenResolver = (over: Loose = {}): AuthResolver =>
  (t) => (t === EXT ? ({ ...GOOD, ...over } as ResolvedBearer) : null);

function get(path: string, token: string): Promise<Response> {
  return fetch(`${handle!.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

function post(path: string, token: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${handle!.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function del(path: string, token: string): Promise<Response> {
  return fetch(`${handle!.url}${path}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hippo-auth-resolver-'));
  initStore(home);
  const db = openHippoDb(home);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'resolver-test', role: 'admin' });
  } finally {
    closeHippoDb(db);
  }
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  vi.restoreAllMocks();
  for (const [k, v] of [['HIPPO_REQUIRE_AUTH', savedEnv.req], ['MCP_SSE_HEARTBEAT_MS', savedEnv.hb]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('auth resolver acceptance', () => {
  it('lets a resolver token reach a tenant route and records its subject as actor', async () => {
    await start(tokenResolver());
    const res = await post('/v1/memories', EXT, { content: 'resolver wrote this' });
    expect(res.status).toBe(200);
    const db = openHippoDb(home);
    try {
      const rows = listAuditEventsAfter(db, { afterId: 0, tenantId: 'ext-tenant' });
      expect(rows.some((r) => r.op === 'remember' && r.actor === 'user-1')).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('keeps API keys working and 401s a token the resolver does not know', async () => {
    await start(tokenResolver());
    expect((await get('/v1/memories?q=x', apiKey.plaintext)).status).toBe(200);
    expect((await get('/v1/memories?q=x', 'nobody.knows')).status).toBe(401);
  });

  it('accepts a resolver token under HIPPO_REQUIRE_AUTH=1', async () => {
    process.env.HIPPO_REQUIRE_AUTH = '1';
    await start(tokenResolver());
    expect((await get('/v1/memories?q=x', EXT)).status).toBe(200);
  });

  it('awaits an async resolver', async () => {
    await start(async (t) => (t === EXT ? GOOD : null));
    expect((await get('/v1/memories?q=x', EXT)).status).toBe(200);
  });
});

describe('auth resolver routing by token shape', () => {
  it('never hands an hk_ token to the resolver', async () => {
    const resolver = vi.fn<AuthResolver>(() => null);
    await start(resolver);
    expect((await get('/v1/memories?q=x', apiKey.plaintext)).status).toBe(200);
    expect((await get('/v1/memories?q=x', 'hk_forged.secret')).status).toBe(401);
    expect(resolver).not.toHaveBeenCalled();
    expect((await get('/v1/memories?q=x', 'ext.other')).status).toBe(401);
    expect(resolver).toHaveBeenCalledWith('ext.other');
  });

  it('lets no resolver answer override an API key identity', async () => {
    const evil: ResolvedBearer = { tenantId: 'evil', subject: 'mallory', role: 'admin' };
    await start(() => evil);
    expect((await post('/v1/memories', apiKey.plaintext, { content: 'key wrote this' })).status).toBe(200);
    expect(auditRows('default').some((r) => r.op === 'remember' && r.actor === `api_key:${apiKey.keyId}`)).toBe(true);
    expect(auditRows('evil')).toHaveLength(0);
    expect((await get('/v1/memories?q=x', 'hk_forged.secret')).status).toBe(401);
  });

  it('answers 401 for a null non-hk_ answer without opening the database', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'hippo-auth-resolver-null-'));
    try {
      await start(() => null, fresh);
      expect((await get('/v1/memories?q=x', 'ext.unknown')).status).toBe(401);
      expect(existsSync(getHippoDbPath(fresh))).toBe(false);
    } finally {
      await handle?.stop();
      handle = undefined;
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('auth resolver tenant boundary', () => {
  it('refuses a resolver admin another tenant audit log but serves its own', async () => {
    await start(tokenResolver({ role: 'admin' }));
    expect((await get('/v1/audit?tenant=default', EXT)).status).toBe(403);
    expect((await get('/v1/audit', EXT)).status).toBe(200);
    expect((await get('/v1/audit?tenant=ext-tenant', EXT)).status).toBe(200);
  });

  it('still lets an API-key admin read another tenant audit log', async () => {
    await start(tokenResolver({ role: 'admin' }));
    expect((await get('/v1/audit?tenant=ext-tenant', apiKey.plaintext)).status).toBe(200);
  });

  it('refuses host-wide sleep to a resolver admin but not to an API-key admin', async () => {
    await start(tokenResolver({ role: 'admin' }));
    expect((await post('/v1/sleep', EXT, {})).status).toBe(403);
    const ok = await fetch(`${handle!.url}/v1/sleep`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey.plaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(ok.status).toBe(200);
  });
});

describe('auth resolver failure', () => {
  it('answers 503 and logs one stderr line without the token when the resolver throws', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await start((t) => {
      throw new Error(`upstream unavailable for ${t}`);
    });
    const res = await get('/v1/memories?q=x', 'secret-token-value');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'auth provider unavailable' });
    const all = write.mock.calls.map((c) => String(c[0]));
    const lines = all.filter((l) => l.includes('auth resolver'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('upstream unavailable for [token]');
    expect(all.join('')).not.toContain('secret-token-value');
  });

  it('keeps a CR/LF resolver message to a single stderr line', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await start(() => {
      throw new Error('first\r\n[hippo] forged line');
    });
    expect((await get('/v1/memories?q=x', 'tok')).status).toBe(503);
    const chunks = write.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('auth resolver'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.replace(/\n$/, '')).not.toMatch(/[\r\n]/);
  });

  it('keeps API keys working while the resolver throws on every token', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await start(() => {
      throw new Error('upstream down');
    });
    expect((await get('/v1/memories?q=x', apiKey.plaintext)).status).toBe(200);
    expect((await get('/v1/memories?q=x', 'ext.anything')).status).toBe(503);
  });

  it('answers 503 when the resolver misses its deadline', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await start(() => new Promise<null>(() => undefined), home, { authResolverTimeoutMs: 100 });
    const res = await get('/v1/memories?q=x', 'ext.slow');
    expect(res.status).toBe(503);
    const lines = write.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('auth resolver'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no answer within 100 ms');
  });
});

describe('auth resolver sanitising', () => {
  it('downgrades an unknown role to member', async () => {
    await start(tokenResolver({ role: 'superuser' }));
    expect((await get('/v1/quarantine', EXT)).status).toBe(403);
  });

  it('keeps an exact admin role', async () => {
    await start(tokenResolver({ role: 'admin' }));
    expect((await get('/v1/quarantine', EXT)).status).toBe(200);
  });

  it.each(['', '   '])('rejects blank tenant %j', async (tenantId) => {
    await start(tokenResolver({ tenantId }));
    expect((await get('/v1/memories?q=x', EXT)).status).toBe(401);
  });

  it.each(['__host__', '__unroutable__', '__anything', 'a\nb', 'x'.repeat(257)])('rejects reserved or malformed tenant %s', async (tenantId) => {
    await start(tokenResolver({ tenantId }));
    expect((await get('/v1/memories?q=x', EXT)).status).toBe(401);
  });

  it('trims surrounding whitespace from the tenant before use', async () => {
    await start(tokenResolver({ tenantId: ' acme ' }));
    expect((await post('/v1/memories', EXT, { content: 'trimmed tenant write' })).status).toBe(200);
    const db = openHippoDb(home);
    try {
      expect(listAuditEventsAfter(db, { afterId: 0, tenantId: 'acme' }).some((r) => r.op === 'remember')).toBe(true);
      expect(listAuditEventsAfter(db, { afterId: 0, tenantId: ' acme ' })).toHaveLength(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('answers 401 with one stderr line when a resolver result has a throwing getter', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await start((t) => {
      if (t !== EXT) return null;
      // SAFETY: subject is added below as a throwing getter, so the object is complete at read time.
      const bad = { tenantId: 'ext-tenant', role: 'member' } as ResolvedBearer;
      Object.defineProperty(bad, 'subject', {
        get() {
          throw new Error('getter exploded');
        },
      });
      return bad;
    });
    expect((await get('/v1/memories?q=x', EXT)).status).toBe(401);
    const lines = write.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('auth resolver'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('getter exploded');
  });

  it.each([
    'api_key:x', 'API_KEY:x', 'localhost:cli', 'cli', 'CLI', 'cli:drill', 'system', 'mcp', 'mcp:bridge', 'connector:slack',
    'sleep', 'sleep:x', 'post-compact', 'recall', 'agent-memories',
  ])('rejects reserved subject %s', async (subject) => {
    await start(tokenResolver({ subject }));
    expect((await get('/v1/memories?q=x', EXT)).status).toBe(401);
  });

  it.each(['clinton@corp.example', 'mcpherson', 'systems-team', 'connectorless'])(
    'accepts a subject that only shares a prefix with a reserved name: %s',
    async (subject) => {
      await start(tokenResolver({ subject }));
      expect((await get('/v1/memories?q=x', EXT)).status).toBe(200);
    },
  );

  it.each([
    ['empty', ''],
    ['overlong', 'a'.repeat(257)],
    ['newline', 'bad\nsubject'],
    ['tab', 'tab\tsubject'],
    ['delete char', 'del\u007f'],
    ['trailing-space reserved', 'system '],
    ['leading-space reserved', ' cli'],
    ['padded', ' user-1 '],
  ])('rejects a %s subject', async (_name, subject) => {
    await start(tokenResolver({ subject }));
    expect((await get('/v1/memories?q=x', EXT)).status).toBe(401);
  });

  it('accepts a 256-character subject', async () => {
    await start(tokenResolver({ subject: 'a'.repeat(256) }));
    expect((await get('/v1/memories?q=x', EXT)).status).toBe(200);
  });

  it('copies string scopes only and drops the rest', async () => {
    writeEntry(home, { ...createMemory('payroll for kowalski', { layer: Layer.Episodic }), scope: PRIVATE_SCOPE });
    const scoped = `/v1/memories?q=kowalski&scope=${encodeURIComponent(PRIVATE_SCOPE)}`;
    await start(tokenResolver({ tenantId: 'default', scopes: [7, null, PRIVATE_SCOPE] }));
    expect((await get(scoped, EXT)).status).toBe(200);
    await handle!.stop();
    await start(tokenResolver({ tenantId: 'default', scopes: [7, null] }));
    expect((await get(scoped, EXT)).status).toBe(403);
  });
});

describe('auth resolver and key routes', () => {
  it('forbids a member resolver actor from creating a key or revoking another key', async () => {
    await start(tokenResolver({ role: 'member' }));
    expect((await post('/v1/auth/keys', EXT, { label: 'x' })).status).toBe(403);
    expect((await del(`/v1/auth/keys/${apiKey.keyId}`, EXT)).status).toBe(403);
  });

  it('lets an admin resolver actor create and revoke a key in its own tenant', async () => {
    await start(tokenResolver({ role: 'admin' }));
    const created = await post('/v1/auth/keys', EXT, { label: 'minted' });
    expect(created.status).toBe(200);
    // SAFETY: a 200 from POST /v1/auth/keys returns the created key record, asserted above.
    const body = (await created.json()) as { keyId: string };
    expect((await del(`/v1/auth/keys/${body.keyId}`, EXT)).status).toBe(200);
  });

  it('mints only member keys for a resolver admin, so a minted key cannot reach another tenant', async () => {
    await start(tokenResolver({ role: 'admin' }));
    expect((await post('/v1/auth/keys', EXT, { role: 'admin' })).status).toBe(403);
    const created = await post('/v1/auth/keys', EXT, {});
    expect(created.status).toBe(200);
    // SAFETY: a 200 from POST /v1/auth/keys returns the created key record, asserted above.
    const minted = (await created.json()) as { plaintext: string; role: string; tenantId: string };
    expect(minted).toMatchObject({ role: 'member', tenantId: 'ext-tenant' });
    expect((await get('/v1/audit?tenant=default', minted.plaintext)).status).toBe(403);
    expect((await post('/v1/sleep', minted.plaintext, {})).status).toBe(403);
    expect((await post('/v1/auth/keys', minted.plaintext, {})).status).toBe(403);
  });

  it('lets a resolver admin revoke member keys in its tenant but not an admin key', async () => {
    const db = openHippoDb(home);
    let admin: CreateApiKeyResult;
    let member: CreateApiKeyResult;
    try {
      admin = createApiKey(db, { tenantId: 'ext-tenant', label: 'host-admin', role: 'admin' });
      member = createApiKey(db, { tenantId: 'ext-tenant', label: 'cli', role: 'member' });
    } finally {
      closeHippoDb(db);
    }
    await start(tokenResolver({ role: 'admin' }));
    expect((await del(`/v1/auth/keys/${admin.keyId}`, EXT)).status).toBe(403);
    expect((await get('/v1/memories?q=x', admin.plaintext)).status).toBe(200);
    expect((await del(`/v1/auth/keys/${member.keyId}`, EXT)).status).toBe(200);
  });
});

describe('exported authRevoke for add-ons', () => {
  const ctx = (tenantId: string): Context => ({
    hippoRoot: home,
    tenantId,
    actor: { subject: 'system:addon:u1', role: 'admin', viaAuthResolver: true },
  });

  function mint(tenantId: string, role: 'admin' | 'member'): CreatedApiKey {
    const db = openHippoDb(home);
    try {
      return createApiKey(db, { tenantId, label: `addon-${role}`, role });
    } finally {
      closeHippoDb(db);
    }
  }

  it('revokes a member key and audits it under the add-on actor', () => {
    const member = mint('ext-tenant', 'member');
    expect(authRevoke(ctx('ext-tenant'), member.keyId).ok).toBe(true);
    const row = auditRows('ext-tenant').find((r) => r.op === 'auth_revoke');
    expect(row).toMatchObject({ actor: 'system:addon:u1', targetId: member.keyId });
  });

  it('refuses an admin key for a resolver admin ctx', () => {
    const admin = mint('ext-tenant', 'admin');
    expect(() => authRevoke(ctx('ext-tenant'), admin.keyId)).toThrow(ForbiddenError);
  });

  it('treats a key in another tenant as unknown', () => {
    const other = mint('other-tenant', 'member');
    expect(() => authRevoke(ctx('ext-tenant'), other.keyId)).toThrow(/Unknown key_id/);
  });
});

describe('isReservedActor', () => {
  it.each(['cli', 'CLI:x', 'api_key:k1', 'system:addon:u1', 'localhost:cli'])('is true for %s', (s) => {
    expect(isReservedActor(s)).toBe(true);
  });

  it.each(['clinton@corp', 'alice@corp', 'systems-team'])('is false for %s', (s) => {
    expect(isReservedActor(s)).toBe(false);
  });
});

describe('auth resolver stream', () => {
  it('opens /mcp/stream for a resolver token without opening the database', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'hippo-auth-resolver-fresh-'));
    try {
      await start(tokenResolver(), fresh);
      const dbPath = getHippoDbPath(fresh);
      expect(existsSync(dbPath)).toBe(false);
      const ac = new AbortController();
      const res = await fetch(`${handle!.url}/mcp/stream`, {
        headers: { accept: 'text/event-stream', authorization: `Bearer ${EXT}` },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      ac.abort();
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      await handle?.stop();
      handle = undefined;
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('closes the stream with auth_revoked when the resolver stops vouching', async () => {
    process.env.MCP_SSE_HEARTBEAT_MS = '100';
    let valid = true;
    await start((t) => (t === EXT && valid ? GOOD : null));
    const ac = new AbortController();
    const res = await fetch(`${handle!.url}/mcp/stream`, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${EXT}` },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    valid = false;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !buf.includes('auth_revoked')) {
      const r = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((ok) => setTimeout(() => ok({ value: undefined, done: true }), 500)),
      ]);
      if (r.value) buf += decoder.decode(r.value);
    }
    ac.abort();
    expect(buf).toContain('auth_revoked');
  }, 10_000);

  it.each(['throws', 'hangs'] as const)(
    'keeps the stream open while the resolver %s, then closes it on a later revocation',
    async (failure) => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      process.env.MCP_SSE_HEARTBEAT_MS = '50';
      let state: 'ok' | 'down' | 'revoked' = 'ok';
      let downCalls = 0;
      await start(
        (t) => {
          if (t !== EXT || state === 'revoked') return null;
          if (state === 'ok') return GOOD;
          downCalls++;
          if (failure === 'throws') throw new Error('upstream down');
          return new Promise<null>(() => undefined);
        },
        home,
        { authResolverTimeoutMs: 60 },
      );
      const ac = new AbortController();
      const res = await openStream(EXT, ac.signal);
      expect(res.status).toBe(200);
      const text = collect(res);
      state = 'down';
      // Two outage checks prove `checking` resets after a 503, so later ticks still run.
      await waitFor(() => downCalls >= 2, 3000);
      expect(downCalls).toBeGreaterThanOrEqual(2);
      expect(text()).not.toContain('event: closed');
      state = 'revoked';
      await waitFor(() => text().includes('auth_revoked'), 3000);
      ac.abort();
      expect(text()).toContain('auth_revoked');
    },
    10_000,
  );

  it('skips a heartbeat tick while a check is still in flight', async () => {
    process.env.MCP_SSE_HEARTBEAT_MS = '50';
    let calls = 0;
    await start(async (t) => {
      if (t !== EXT) return null;
      calls++;
      await new Promise((ok) => setTimeout(ok, 400));
      return GOOD;
    });
    const ac = new AbortController();
    const res = await fetch(`${handle!.url}/mcp/stream`, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${EXT}` },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    const afterOpen = calls;
    await new Promise((ok) => setTimeout(ok, 500));
    ac.abort();
    expect(calls - afterOpen).toBeLessThanOrEqual(2);
  }, 10_000);

  it('starts no heartbeat when the client leaves while the resolver is still answering', async () => {
    process.env.MCP_SSE_HEARTBEAT_MS = '50';
    let calls = 0;
    await start(async (t) => {
      if (t !== EXT) return null;
      calls++;
      await new Promise((ok) => setTimeout(ok, 300));
      return GOOD;
    });
    const ac = new AbortController();
    const opened = fetch(`${handle!.url}/mcp/stream`, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${EXT}` },
      signal: ac.signal,
    }).catch(() => undefined);
    await new Promise((ok) => setTimeout(ok, 100));
    ac.abort();
    await opened;
    await new Promise((ok) => setTimeout(ok, 500));
    const settled = calls;
    await new Promise((ok) => setTimeout(ok, 700));
    expect(settled).toBe(1);
    expect(calls).toBe(settled);
  }, 10_000);

  it('writes nothing after close when a heartbeat check was already in flight', async () => {
    process.env.MCP_SSE_HEARTBEAT_MS = '50';
    let calls = 0;
    await start(async (t) => {
      if (t !== EXT) return null;
      calls++;
      if (calls > 1) await new Promise((ok) => setTimeout(ok, 300));
      return GOOD;
    });
    const pings: string[] = [];
    const realWrite = ServerResponse.prototype.write;
    // SAFETY: the spy forwards every argument unchanged; it only records ping writes.
    vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function (this: ServerResponse, ...args: Parameters<typeof realWrite>) {
      if (String(args[0]) === ': ping\n\n') pings.push('ping');
      return realWrite.apply(this, args);
    });
    const ac = new AbortController();
    const res = await fetch(`${handle!.url}/mcp/stream`, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${EXT}` },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    await new Promise((ok) => setTimeout(ok, 120));
    expect(calls).toBeGreaterThanOrEqual(2);
    ac.abort();
    await new Promise((ok) => setTimeout(ok, 80));
    const atClose = pings.length;
    await new Promise((ok) => setTimeout(ok, 600));
    expect(pings.length).toBe(atClose);
  }, 10_000);
});

describe('package surface', () => {
  const root = resolve(__dirname, '..');

  it('resolves hippo-memory/server by name and keeps the server out of the index', () => {
    const script = [
      "const url = import.meta.resolve('hippo-memory/server');",
      "const srv = await import('hippo-memory/server');",
      "const idx = await import('hippo-memory');",
      "const names = ['appendAuditEvent','queryAuditEvents','listAuditEventsAfter','AUDIT_OPS','openHippoDb','closeHippoDb'];",
      'console.log(JSON.stringify({ url, serve: typeof srv.serve, authRevoke: typeof srv.authRevoke, isReservedActor: typeof srv.isReservedActor, forbidden: typeof srv.ForbiddenError, missing: names.filter((n) => idx[n] === undefined), indexServe: "serve" in idx }));',
    ].join('\n');
    // cwd is the checkout because self-reference resolves from the nearest package.json.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    if (child.status !== 0) throw new Error(`self-reference import failed (run \`npm run build\` first):\n${child.stderr}`);
    const lines = child.stdout.trim().split('\n');
    // SAFETY: the child script above is the only writer of the last stdout line and always emits these keys.
    const out = JSON.parse(lines[lines.length - 1]!) as {
      url: string; serve: string; authRevoke: string; isReservedActor: string; forbidden: string; missing: string[]; indexServe: boolean;
    };
    expect(out.authRevoke).toBe('function');
    expect(out.isReservedActor).toBe('function');
    expect(out.forbidden).toBe('function');
    expect(realpathSync(fileURLToPath(out.url))).toBe(realpathSync(join(root, 'dist', 'server.js')));
    expect(out.serve).toBe('function');
    expect(out.missing).toEqual([]);
    expect(out.indexServe).toBe(false);
  });
});
