// A dashboard request that fails logs its route and status through the server's failure line, never its path or query,
// so the access token in a URL stays out of the log. The committed-write case lives in tests/api/dashboard-detail.server.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveDashboard } from '../src/server/dashboard-listener.js';
import type { ServerHandle } from '../src/server/types.js';
import { DASHBOARD_TOKEN, get, makeStore, type TmpStore } from './_helpers/dashboard-fixture.js';

let store: TmpStore;
let dash: ServerHandle;

beforeEach(async () => {
  store = makeStore('hippo-dash-failure-log');
  // A session id is no tenant, so every card read under it fails.
  dash = await serveDashboard({ hippoRoot: store.hippoRoot, port: 0, token: DASHBOARD_TOKEN, tenantId: 'sess_x' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dash.stop();
  store.cleanup();
});

describe('a failing API request that carries the access token', () => {
  it('logs the route once and never the token', async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const reply = await get(dash.port, `/api/cards?token=${DASHBOARD_TOKEN}`);

    expect(reply.status).toBe(500);
    expect(written.filter((line) => line.includes('GET /api/cards failed'))).toHaveLength(1);
    expect(written.some((line) => line.includes(DASHBOARD_TOKEN))).toBe(false);
  });
});
