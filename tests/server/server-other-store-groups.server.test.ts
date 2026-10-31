// serve() under a store without hippo.db's local tier answers 501 on every tier route from boot, after the
// key check, and serves the core paths.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { STORE_NOT_PORTED_MESSAGE } from '../../src/base/errors/http-errors.js';
import type { ServerHandle } from '../../src/server.js';
import { serve } from '../_helpers/store-switch.js';
import { seedTwoTenants, type TwoTenantFixture } from '../_helpers/store-conformance.js';
import { portOnlyStore } from '../_helpers/port-only-store.js';

describe('serve() under a store without the local tier', () => {
  let fixture: TwoTenantFixture;
  let handle: ServerHandle;

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    vi.stubEnv('HIPPO_CALLER_RPS', '0');
    fixture = seedTwoTenants();
    handle = await serve({ hippoRoot: fixture.dir, port: 0, store: portOnlyStore(fixture.dir) });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  const call = async (
    method: string,
    path: string,
    token?: string,
    body = '{}',
  ): Promise<{ status: number; body: unknown }> => {
    const headers = new Headers({ 'content-type': 'application/json', 'x-hippo-project': 'proj' });
    if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
    const res = await fetch(`${handle.url}${path}`, { method, headers, body: method === 'GET' ? undefined : body });
    return { status: res.status, body: await res.json() };
  };
  const refused = { status: 501, body: { error: STORE_NOT_PORTED_MESSAGE } };

  it('answers 501 on an objects or quarantine route after the key checks out, and a bad key is still a 401', async () => {
    const { adminA, revokedA } = fixture.tokens;
    expect(await call('GET', '/v1/predictions', adminA)).toEqual(refused);
    expect(await call('GET', '/v1/quarantine', adminA)).toEqual(refused);
    expect((await call('GET', '/v1/predictions', revokedA)).status).toBe(401);
  });

  it('answers 501 on graph, drill and assemble after the key check, and serves remember, recall and context', async () => {
    const { adminA, revokedA } = fixture.tokens;
    expect(await call('GET', '/v1/graph?entity=Shared', adminA)).toEqual(refused);
    expect(await call('GET', '/v1/recall/drill/sum_x', adminA)).toEqual(refused);
    expect(await call('GET', '/v1/sessions/sess-x/assemble', adminA)).toEqual(refused);
    expect((await call('GET', '/v1/graph?entity=Shared', revokedA)).status).toBe(401);

    const content = 'the core groups serve the core paths';
    expect((await call('POST', '/v1/memories', adminA, JSON.stringify({ content }))).status).toBe(200);
    const recalled = await call('GET', '/v1/memories?q=core%20groups', adminA);
    expect(recalled.status).toBe(200);
    expect(JSON.stringify(recalled.body)).toContain(content);
    const context = await call('GET', '/v1/context?q=core%20groups&project=proj', adminA);
    expect(context.status).toBe(200);
    expect(JSON.stringify(context.body)).toContain(content);
  });

  it('answers 501 on both connector webhooks before reading the body', async () => {
    expect(await call('POST', '/v1/connectors/slack/events')).toEqual(refused);
    expect(await call('POST', '/v1/connectors/github/events')).toEqual(refused);
  });
});
