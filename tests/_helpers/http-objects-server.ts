// One server for the http-objects tests: the request limits are off and every test makes its own rows.
import { beforeAll, afterAll, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { ServerHandle } from '../../src/server.js';
import { serve } from './store-switch.js';
import { createApiKey, type CreateApiKeyResult } from '../../src/store/sqlite/auth.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { makeRoot } from '../_helpers/make-root.js';

export type Body = { [key: string]: JsonValue };

let home: string;
export let handle: ServerHandle;
let apiKey: CreateApiKeyResult;
export let apiKeyB: CreateApiKeyResult;

export function useObjectsServer() {
  beforeAll(async () => {
    home = makeRoot('http-objects');
    const db = openHippoDb(home);
    try {
      apiKey = createApiKey(db, { tenantId: 'default', label: 'test-objects', role: 'admin' });
      apiKeyB = createApiKey(db, { tenantId: 'tenant-b', label: 'test-objects-b', role: 'admin' });
    } finally {
      closeHippoDb(db);
    }
    handle = await serve({ hippoRoot: home, port: 0, rateLimits: { perCaller: 'off', perAddress: 'off' } });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });
}

export function authHeaders(key: CreateApiKeyResult = apiKey) {
  return { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' };
}

export async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: every response here comes from a typed-object route under test, whose envelope is { <field>: row } or
  // { <listField>: row[] }; the assertions after each call pin the fields read.
  return (await res.json()) as T;
}

export function post(path: string, body?: Body, key: CreateApiKeyResult = apiKey): Promise<Response> {
  return fetch(`${handle.url}${path}`, {
    method: 'POST',
    headers: authHeaders(key),
    body: body && JSON.stringify(body),
  });
}

export function get(path: string, key: CreateApiKeyResult = apiKey): Promise<Response> {
  return fetch(`${handle.url}${path}`, { headers: authHeaders(key) });
}
