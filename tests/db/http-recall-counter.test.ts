// A recall served over GET /v1/memories left total_recalled untouched, so
// `hippo stats` reported a number that depended on which surface the caller
// used. Same class as the 1.38.7 archive and 1.38.9 forget counter bugs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openHippoDb, closeHippoDb, getMeta } from '../../src/db/index.js';
import { remember, retrieve } from '../../src/api/index.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { __resetSessionRecallHistoryHttp } from '../../src/entry/testing.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

let home: string;
let handle: ServerHandle;

function ctx() {
  return apiCtx(home, 'default', { subject: 'test', role: 'admin' as const });
}

function totalRecalled(): number {
  const db = openHippoDb(home);
  try {
    return Number(getMeta(db, 'total_recalled', '0'));
  } finally {
    closeHippoDb(db);
  }
}

async function httpRecall(qs: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle.port}/v1/memories?${qs}`);
}

beforeEach(async () => {
  __resetSessionRecallHistoryHttp();
  home = makeRoot('http-recall-count');
  for (const content of ['alpha token one', 'alpha token two', 'alpha token three']) {
    await remember(ctx(), { content });
  }
  handle = await serve({ hippoRoot: home, port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await handle.stop();
});

describe('GET /v1/memories counts toward total_recalled', () => {
  it('adds exactly the number of results it returned', async () => {
    expect(totalRecalled()).toBe(0);

    const res = await httpRecall('q=alpha&limit=10');
    expect(res.status).toBe(200);
    const body: { results: unknown[] } = await res.json();
    expect(body.results.length).toBe(3);

    expect(totalRecalled()).toBe(3);
  });

  it('counts the capped result set, not the number of matches', async () => {
    const res = await httpRecall('q=alpha&limit=2');
    const body: { results: unknown[] } = await res.json();
    expect(body.results.length).toBe(2);
    expect(totalRecalled()).toBe(2);
  });

  // A non-matching query is not an empty response: recall falls back to
  // recency (scores 1, 0.9, 0.8 here), and the counter follows what was sent.
  it('counts the recency fallback a non-matching query returns', async () => {
    const res = await httpRecall('q=zzzznothingmatches&limit=10');
    expect(res.status).toBe(200);
    const body: { results: unknown[] } = await res.json();
    expect(body.results.length).toBe(3);
    expect(totalRecalled()).toBe(3);
  });

  it('does not count a rejected request', async () => {
    const res = await httpRecall('q=alpha&limit=-5');
    expect(res.status).toBe(400);
    expect(totalRecalled()).toBe(0);
  });

  // Pins where the counter is NOT, so the route's site cannot double-count:
  // api.recall stays silent, which is also why MCP's band never counts.
  it('leaves api.recall itself uncounted', async () => {
    await httpRecall('q=alpha&limit=10');
    expect(totalRecalled()).toBe(3);

    const direct = await retrieve(ctx(), { query: 'alpha', window: { limit: 10 } });
    expect(direct.results.length).toBe(3);
    expect(totalRecalled()).toBe(3);
  });
});
