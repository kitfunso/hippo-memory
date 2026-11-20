// POST and DELETE /v1/auth/keys/:keyId/grants: an admin key changes a member key's read grant over HTTP. Real server and store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createApiKey, grantScope, revokeApiKey } from '../../src/store/sqlite/keys/auth.js';
import { MAX_ID_LEN } from '../../src/base/util/limits.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const S2 = 'slack:private:c2';

interface Reply {
  readonly status: number;
  readonly body: { error?: string; keyId?: string; scope?: string; granted?: boolean };
}

describe('grant routes', () => {
  let home: string;
  let handle: ServerHandle;
  let admin: string;

  function mint(role: 'admin' | 'member', tenantId = 'default'): { plaintext: string; keyId: string } {
    const db = openHippoDb(home);
    try {
      return createApiKey(db, { tenantId, label: `${role}-test`, role });
    } finally {
      closeHippoDb(db);
    }
  }

  async function call(method: 'POST' | 'DELETE', keyId: string, key: string, scope?: string): Promise<Reply> {
    const base = `${handle.url}/v1/auth/keys/${keyId}/grants`;
    const res =
      method === 'POST'
        ? await fetch(base, {
            method,
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify(scope === undefined ? {} : { scope }),
          })
        : await fetch(scope === undefined ? base : `${base}?scope=${encodeURIComponent(scope)}`, {
            method,
            headers: { authorization: `Bearer ${key}` },
          });
    return { status: res.status, body: await res.json() };
  }

  async function recallStatus(key: string, scope: string): Promise<number> {
    const res = await fetch(`${handle.url}/v1/memories?q=payroll&scope=${encodeURIComponent(scope)}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    return res.status;
  }

  beforeEach(async () => {
    home = makeRoot('auth-grant-routes');
    admin = mint('admin').plaintext;
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it('an admin grants a scope and the key reads it on its next request, then ungrants it and the read is 403', async () => {
    const member = mint('member');
    expect(await recallStatus(member.plaintext, S2)).toBe(403);

    expect(await call('POST', member.keyId, admin, S2)).toEqual({
      status: 200,
      body: { keyId: member.keyId, scope: S2, granted: true },
    });
    expect(await recallStatus(member.plaintext, S2)).toBe(200);

    expect(await call('DELETE', member.keyId, admin, S2)).toEqual({
      status: 200,
      body: { keyId: member.keyId, scope: S2, granted: false },
    });
    expect(await recallStatus(member.plaintext, S2)).toBe(403);
  });

  it('refuses a member key on either route with a 403', async () => {
    const member = mint('member');
    const other = mint('member');
    for (const method of ['POST', 'DELETE'] as const) {
      const reply = await call(method, other.keyId, member.plaintext, S2);
      expect(reply.status).toBe(403);
      expect(reply.body.error).toBe(`/v1/auth/keys/:keyId/grants requires admin role`);
    }
  });

  it('answers a key of another tenant, or no key, with the same 404', async () => {
    const foreign = mint('member', 'other-tenant');
    for (const keyId of [foreign.keyId, 'hk_absent']) {
      for (const method of ['POST', 'DELETE'] as const) {
        const reply = await call(method, keyId, admin, S2);
        expect(reply.status).toBe(404);
        expect(reply.body.error).toBe(`Unknown key_id: ${keyId}`);
      }
    }
  });

  it('refuses a personal scope and an unrestricted scope with a 400', async () => {
    const member = mint('member');
    expect((await call('POST', member.keyId, admin, 'personal:x')).status).toBe(400);
    expect((await call('POST', member.keyId, admin, 'personal:private:alice')).status).toBe(400);
    expect((await call('POST', member.keyId, admin, 'team:eng')).status).toBe(400);
    expect((await call('DELETE', member.keyId, admin, 'team:eng')).status).toBe(400);
  });

  it('refuses a missing, blank or over-long scope with a 400', async () => {
    const member = mint('member');
    for (const method of ['POST', 'DELETE'] as const) {
      expect((await call(method, member.keyId, admin)).status).toBe(400);
      expect((await call(method, member.keyId, admin, '  ')).status).toBe(400);
      expect((await call(method, member.keyId, admin, 'x'.repeat(MAX_ID_LEN + 1))).status).toBe(400);
    }
  });

  it('refuses a padded grant with a 400 and still revokes a padded grant stored before that rule', async () => {
    const member = mint('member');
    const padded = `${S2} `;
    const refused = await call('POST', member.keyId, admin, padded);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('scope must not start or end with a space');

    const db = openHippoDb(home);
    try {
      grantScope(db, member.keyId, padded);
    } finally {
      closeHippoDb(db);
    }
    expect(await call('DELETE', member.keyId, admin, padded)).toEqual({
      status: 200,
      body: { keyId: member.keyId, scope: padded, granted: false },
    });
  });

  it('refuses a grant on a revoked key with a 409', async () => {
    const member = mint('member');
    const db = openHippoDb(home);
    try {
      revokeApiKey(db, member.keyId);
    } finally {
      closeHippoDb(db);
    }
    expect((await call('POST', member.keyId, admin, S2)).status).toBe(409);
  });
});
