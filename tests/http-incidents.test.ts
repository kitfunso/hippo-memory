/**
 * E2 incident first-class object — HTTP route parity test.
 * Docs: docs/plans/2026-05-29-e2-incident-object.md
 *
 * Covers what only incidents have; the shared route rules run per kind in http-objects.test.ts.
 * 1. GET /v1/incidents lists + status filter
 * 2. POST /v1/incidents/:id/resolve resolves open (+409 on re-resolve)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../src/server.js';
import { createApiKey, type CreateApiKeyResult } from '../src/store/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import type { Incident } from '../src/objects/incidents.js';
import { makeRoot } from './_helpers/make-root.js';

/** Parse a fetch Response body against a caller-declared shape. */
async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: only used against this file's own /v1/incidents route responses,
  // whose JSON shape is fixed by the handler in src/server.ts and checked by
  // the assertions immediately following each call site.
  return (await res.json()) as T;
}

let home: string;
let handle: ServerHandle;
let apiKey: CreateApiKeyResult;

beforeEach(async () => {
  home = makeRoot('http-inc');
  const db = openHippoDb(home);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-inc', role: 'admin' });
  } finally {
    closeHippoDb(db);
  }
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

function authHeaders(key: CreateApiKeyResult = apiKey) {
  return { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' };
}

async function createIncident(
  text: string,
  extra: { context?: string; linkedMemoryIds?: string[] } = {},
  key: CreateApiKeyResult = apiKey,
) {
  return fetch(`${handle.url}/v1/incidents`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify({ text, ...extra }),
  });
}

describe('HTTP /v1/incidents (incident first-class object)', () => {
  it('GET /v1/incidents lists and filters by status', async () => {
    await createIncident('open one');
    const toClose = (await jsonAs<{ incident: Incident }>(await createIncident('to close'))).incident;
    await fetch(`${handle.url}/v1/incidents/${toClose.id}/close`, { method: 'POST', headers: authHeaders() });

    const allRes = await fetch(`${handle.url}/v1/incidents`, { headers: authHeaders() });
    expect(allRes.status).toBe(200);
    const all = await jsonAs<{ incidents: Incident[] }>(allRes);
    expect(all.incidents.length).toBe(2);

    const openRes = await fetch(`${handle.url}/v1/incidents?status=open`, { headers: authHeaders() });
    const open = await jsonAs<{ incidents: Incident[] }>(openRes);
    expect(open.incidents.length).toBe(1);
    expect(open.incidents[0].status).toBe('open');
  });

  it('POST /v1/incidents/:id/resolve resolves an open incident (+409 on re-resolve)', async () => {
    const inc = (await jsonAs<{ incident: Incident }>(await createIncident('API 500s'))).incident;
    const resRes = await fetch(`${handle.url}/v1/incidents/${inc.id}/resolve`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ resolutionText: 'restarted workers' }),
    });
    expect(resRes.status).toBe(200);
    const resolved = (await jsonAs<{ incident: Incident }>(resRes)).incident;
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolutionText).toBe('restarted workers');

    // re-resolving the already-resolved incident -> 409
    const conflict = await fetch(`${handle.url}/v1/incidents/${inc.id}/resolve`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ resolutionText: 'again' }),
    });
    expect(conflict.status).toBe(409);
  });
});
