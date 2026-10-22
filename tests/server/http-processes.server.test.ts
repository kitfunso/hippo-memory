/**
 * E2 process first-class object — HTTP route parity test.
 * Docs: docs/plans/2026-05-29-e2-process-object.md
 *
 * Covers what only processes have; the shared route rules run per kind in http-objects.server.test.ts.
 * 1. GET /v1/processes lists + status filter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import type { ServerHandle } from '../../src/server.js';
import { serve } from '../_helpers/store-switch.js';
import { createApiKey, type CreateApiKeyResult } from '../../src/store/sqlite/auth.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import type { Process } from '../../src/domain/objects/processes.js';
import { makeRoot } from '../_helpers/make-root.js';

let home: string;
let handle: ServerHandle;
let apiKey: CreateApiKeyResult;

beforeEach(async () => {
  home = makeRoot('http-proc');
  const db = openHippoDb(home);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-proc', role: 'admin' });
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

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: T is pinned by each call site to the exact JSON envelope the
  // /v1/processes route handlers (src/server.ts) return; every call site
  // asserts the specific fields it reads immediately after this call.
  return res.json() as Promise<T>;
}

interface ProcessCreateExtra {
  steps?: string[];
  description?: string;
}

async function createProcess(processName: string, extra: ProcessCreateExtra = {}, key: CreateApiKeyResult = apiKey) {
  return fetch(`${handle.url}/v1/processes`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify({ processName, ...extra }),
  });
}

describe('HTTP /v1/processes (process first-class object)', () => {
  it('GET /v1/processes lists and filters by status', async () => {
    const v1 = (await jsonAs<{ process: Process }>(await createProcess('Deploy', { steps: ['a'] }))).process;
    await fetch(`${handle.url}/v1/processes/${v1.id}/supersede`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ steps: ['a', 'b'], changeSummary: 'added b' }),
    });

    const allRes = await fetch(`${handle.url}/v1/processes`, { headers: authHeaders() });
    expect(allRes.status).toBe(200);
    const all = await jsonAs<{ processes: Process[] }>(allRes);
    expect(all.processes.length).toBe(2);

    const activeRes = await fetch(`${handle.url}/v1/processes?status=active`, { headers: authHeaders() });
    const active = await jsonAs<{ processes: Process[] }>(activeRes);
    expect(active.processes.length).toBe(1);
    expect(active.processes[0].version).toBe(2);
  });
});
