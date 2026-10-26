// The route table's gate is where a caller is refused: sleep takes only a caller on this host with no proxy or page in
// between, and key minting refuses a member before it reads the body.
import * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerHandle } from '../../src/server.js';
import { serve } from '../_helpers/store-switch.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/sqlite/auth.js';
import { makeRoot } from '../_helpers/make-root.js';

interface Reply {
  status: number;
  error: string;
}

let handle: ServerHandle;
let adminKey: string;
let memberKey: string;

beforeEach(async () => {
  const root = makeRoot('route-gates');
  const db = openHippoDb(root);
  try {
    adminKey = createApiKey(db, { tenantId: 'default', label: 'gate-admin', role: 'admin' }).plaintext;
    memberKey = createApiKey(db, { tenantId: 'default', label: 'gate-member', role: 'member' }).plaintext;
  } finally {
    closeHippoDb(db);
  }
  handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
});

afterEach(async () => {
  await handle.stop();
});

// node:http, since fetch will not send a Host header of the caller's choosing.
function post(path: string, key: string, body: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: handle.port,
        method: 'POST',
        path,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, error: String(JSON.parse(text || '{}').error ?? '') }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('POST /v1/sleep', () => {
  it('refuses a host admin whose request came through a proxy on this host', async () => {
    const r = await post('/v1/sleep', adminKey, '{}', { 'x-forwarded-for': '203.0.113.9' });
    expect(r).toEqual({ status: 403, error: expect.stringContaining('loopback-only') });
  });

  it('refuses a host admin whose request names another host', async () => {
    const r = await post('/v1/sleep', adminKey, '{}', { host: 'hippo.example.com' });
    expect(r).toEqual({ status: 403, error: expect.stringContaining('loopback-only') });
  });
});

describe('POST /v1/auth/keys', () => {
  it('refuses a member key at the gate', async () => {
    expect(await post('/v1/auth/keys', memberKey, '{"role":"member"}')).toEqual({
      status: 403,
      error: '/v1/auth/keys requires admin role',
    });
  });

  it('refuses a member key before reading a body over the mint cap', async () => {
    const r = await post('/v1/auth/keys', memberKey, JSON.stringify({ label: 'x'.repeat(8 * 1024) }));
    expect(r.status).toBe(403);
  });

  it('still mints for an admin key', async () => {
    expect((await post('/v1/auth/keys', adminKey, '{"role":"member"}')).status).toBe(200);
  });
});
