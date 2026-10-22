// POST /v1/vectors/nearest refuses a malformed body with a 400 that names the field, and answers the served store's
// nearest ids for the caller's tenant.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServerHandle } from '../../src/server.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { MAX_ID_LEN, MAX_LIST_LIMIT } from '../../src/base/util/limits.js';
import { serveAsAdmin } from '../_helpers/admin-server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { seedVectorRows } from '../_helpers/vector-rows.js';
import { needsHippoDb } from '../_helpers/store-switch.js';

const SPEC = { tenantId: 'default', includeSuperseded: false };

let handle: ServerHandle;

beforeAll(async () => {
  vi.stubEnv('HIPPO_HOME', makeRoot('nearest-route-global'));
  const root = makeRoot('nearest-route');
  seedVectorRows(root, [
    { id: 'far', tenantId: 'default', vector: [0, 1, 0] },
    { id: 'nearest', tenantId: 'default', vector: [1, 0, 0] },
    { id: 'near', tenantId: 'default', vector: [1, 0.2, 0] },
    { id: 'elsewhere', tenantId: 'other', vector: [1, 0, 0] },
  ]);
  handle = await serveAsAdmin({ hippoRoot: root, port: 0 });
});

afterAll(async () => {
  await handle.stop();
  vi.unstubAllEnvs();
});

async function post(body: JsonValue): Promise<{ status: number; json: { ids?: string[]; error?: string } }> {
  const res = await fetch(`${handle.url}/v1/vectors/nearest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('POST /v1/vectors/nearest', () => {
  it.each([
    ['no vector', { spec: SPEC }, 'vector must be an array of 1 to 4096 numbers'],
    ['an empty vector', { vector: [], spec: SPEC }, 'vector must be an array of 1 to 4096 numbers'],
    ['a vector past 4096', { vector: Array(4097).fill(0), spec: SPEC }, 'vector must be an array of 1 to 4096 numbers'],
    ['a vector with a string', { vector: [1, '0'], spec: SPEC }, 'vector must hold finite numbers only'],
    ['no spec', { vector: [1, 0, 0] }, 'spec must be an object'],
    [
      'no includeSuperseded',
      { vector: [1, 0, 0], spec: { tenantId: 'default' } },
      'spec.includeSuperseded must be a boolean',
    ],
    [
      'a limit of 0',
      { vector: [1, 0, 0], spec: { ...SPEC, limit: 0 } },
      `spec.limit must be an integer from 1 to ${MAX_LIST_LIMIT}`,
    ],
    [
      'a long tenant',
      { vector: [1, 0, 0], spec: { ...SPEC, tenantId: 'x'.repeat(MAX_ID_LEN + 1) } },
      `spec.tenantId must be a string of at most ${MAX_ID_LEN} characters`,
    ],
    [
      'an unknown scope mode',
      { vector: [1, 0, 0], spec: { ...SPEC, scope: { mode: 'all', value: 'x' } } },
      'spec.scope.mode must be default-deny, exact or default-deny-or-exact',
    ],
    [
      '65 origins',
      { vector: [1, 0, 0], spec: { ...SPEC, origin: Array(65).fill('p') } },
      'spec.origin must be a string or a list of at most 64',
    ],
  ])('answers 400 to %s', async (_name, body, error) => {
    expect(await post(body)).toEqual({ status: 400, json: { error } });
  });

  it.skipIf(needsHippoDb('team'))("answers the caller's tenant's nearest ids, and 403 for another tenant", async () => {
    expect(await post({ vector: [1, 0, 0], spec: { ...SPEC, limit: 2 } })).toEqual({
      status: 200,
      json: { ids: ['nearest', 'near'] },
    });
    expect((await post({ vector: [1, 0, 0], spec: { ...SPEC, tenantId: 'other' } })).status).toBe(403);
  });
});
