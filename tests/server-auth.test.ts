import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { createApiKey, revokeApiKey } from '../src/store/auth.js';
import { queryAuditEvents } from '../src/store/audit.js';
import { serve, type ServerHandle } from '../src/server.js';
import type { RememberResult } from '../src/api/index.js';
import { presentConnectionsAsRemote } from './_helpers/listen.js';
import { makeRoot } from './_helpers/make-root.js';

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: T is pinned by each call site to the exact JSON envelope the
  // route handler (src/server.ts) returns for that request; every call
  // site asserts the specific fields it reads immediately after this call.
  return res.json() as Promise<T>;
}

describe('server auth middleware', () => {
  let home: string;
  let globalHome: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot('srv-auth');
    globalHome = makeRoot('srv-auth');
    vi.stubEnv('HIPPO_HOME', globalHome);
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('loopback no-auth: 200 and audit shows actor=localhost:cli', async () => {
    const res = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'auth-canary-loopback-noauth' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<RememberResult>(res);
    expect(body.id).toMatch(/^mem_/);

    const db = openHippoDb(home);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'remember' });
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]!.actor).toBe('localhost:cli');
      expect(events[0]!.targetId).toBe(body.id);
    } finally {
      closeHippoDb(db);
    }
  });

  it('loopback with valid Bearer: 200 and audit shows actor=api_key:<keyId>', async () => {
    const db = openHippoDb(home);
    let keyId: string;
    let plaintext: string;
    try {
      const created = createApiKey(db, { tenantId: 'default', label: 'auth-test' });
      keyId = created.keyId;
      plaintext = created.plaintext;
    } finally {
      closeHippoDb(db);
    }

    const res = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Mixed case scheme to confirm case-insensitive matching.
        'Authorization': `Bearer ${plaintext}`,
      },
      body: JSON.stringify({ content: 'auth-canary-bearer-valid' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<RememberResult>(res);
    expect(body.id).toMatch(/^mem_/);
    expect(body.tenantId).toBe('default');

    const db2 = openHippoDb(home);
    try {
      const events = queryAuditEvents(db2, { tenantId: 'default', op: 'remember' });
      const matching = events.find((e) => e.targetId === body.id);
      expect(matching).toBeDefined();
      expect(matching!.actor).toBe(`api_key:${keyId}`);
    } finally {
      closeHippoDb(db2);
    }
  });

  it('loopback with invalid Bearer: 401 and no remember audit event', async () => {
    const res = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer hk_does_not_exist.bogussecret',
      },
      body: JSON.stringify({ content: 'auth-canary-bearer-invalid' }),
    });
    expect(res.status).toBe(401);
    const body = await jsonAs<{ error: string }>(res);
    expect(body.error).toBe('invalid api key');

    const db = openHippoDb(home);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'remember' });
      // No remember should have landed.
      expect(events.length).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('loopback with revoked Bearer: 401', async () => {
    const db = openHippoDb(home);
    let plaintext: string;
    try {
      const created = createApiKey(db, { tenantId: 'default', label: 'revoke-test' });
      plaintext = created.plaintext;
      revokeApiKey(db, created.keyId);
    } finally {
      closeHippoDb(db);
    }

    const res = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${plaintext}`,
      },
      body: JSON.stringify({ content: 'auth-canary-revoked' }),
    });
    expect(res.status).toBe(401);
  });

  it('loopback with malformed Authorization (no scheme): 401', async () => {
    const res = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'just-a-token-no-scheme',
      },
      body: JSON.stringify({ content: 'auth-canary-malformed' }),
    });
    expect(res.status).toBe(401);
    const body = await jsonAs<{ error: string }>(res);
    expect(body.error).toBe('invalid api key');
  });

  it('loopback with non-Bearer scheme: 401', async () => {
    const res = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Basic dXNlcjpwYXNz',
      },
      body: JSON.stringify({ content: 'auth-canary-basic' }),
    });
    expect(res.status).toBe(401);
  });
});

// The server binds loopback; every accepted socket is relabelled with a public peer address before the request handler reads it.
describe('server auth middleware for a non-loopback peer', () => {
  let home: string;
  let globalHome: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot('srv-auth');
    globalHome = makeRoot('srv-auth');
    vi.stubEnv('HIPPO_HOME', globalHome);
    handle = await serve({ hippoRoot: home, port: 0 });
    presentConnectionsAsRemote(handle.server!);
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  function rememberAs(content: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ content }),
    });
  }

  function rememberEvents(): ReturnType<typeof queryAuditEvents> {
    const db = openHippoDb(home);
    try {
      return queryAuditEvents(db, { tenantId: 'default', op: 'remember' });
    } finally {
      closeHippoDb(db);
    }
  }

  it('no Authorization: 401 and nothing is written', async () => {
    const res = await rememberAs('auth-canary-remote-noauth');
    expect(res.status).toBe(401);
    expect((await jsonAs<{ error: string }>(res)).error).toBe('auth required');
    expect(rememberEvents()).toEqual([]);
  });

  it('valid Bearer: 200, so the 401 above comes from the missing key and not the relabelled socket', async () => {
    const db = openHippoDb(home);
    let created: ReturnType<typeof createApiKey>;
    try {
      created = createApiKey(db, { tenantId: 'default', label: 'remote-test' });
    } finally {
      closeHippoDb(db);
    }
    const res = await rememberAs('auth-canary-remote-bearer', { authorization: `Bearer ${created.plaintext}` });
    expect(res.status).toBe(200);
    const body = await jsonAs<RememberResult>(res);
    expect(rememberEvents().find((e) => e.targetId === body.id)?.actor).toBe(`api_key:${created.keyId}`);
  });
});
