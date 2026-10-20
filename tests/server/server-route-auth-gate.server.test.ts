// The /v1 table declares each route's auth need and dispatch enforces it before any handler runs.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../../src/server.js';
import { V1_ROUTES } from '../../src/surface/server/route-table.js';
import { makeRoot } from '../_helpers/make-root.js';
import { V1_ROWS } from '../_helpers/v1-route-rows.js';
import { initTestStore } from '../_helpers/store-template.js';

const KNOWN_AUTH: ReadonlySet<string> = new Set(['caller', 'admin', 'host-admin-local', 'webhook-signature']);
const WEBHOOKS = ['POST /v1/connectors/slack/events', 'POST /v1/connectors/github/events'];

// What a request with no credential gets today, route by route; a new route fails the coverage check until it is listed.
const NO_CREDENTIAL = {
  'POST /v1/memories': 401,
  'GET /v1/graph': 401,
  'GET /v1/memories': 401,
  'GET /v1/sessions/:id/assemble': 401,
  'GET /v1/recall/drill/:id': 401,
  'POST /v1/memories/:id/archive': 401,
  'POST /v1/memories/:id/supersede': 401,
  'POST /v1/memories/:id/promote': 401,
  'DELETE /v1/memories/:id': 401,
  'POST /v1/outcome': 401,
  'GET /v1/context': 401,
  'POST /v1/sleep': 401,
  'POST /v1/auth/keys': 401,
  'GET /v1/auth/keys': 401,
  'DELETE /v1/auth/keys/:keyId': 401,
  'GET /v1/quarantine': 401,
  'POST /v1/quarantine/:id/approve': 401,
  'POST /v1/quarantine/:id/reject': 401,
  'GET /v1/audit': 401,
  'POST /v1/predictions': 401,
  'GET /v1/predictions': 401,
  'GET /v1/predictions/stats': 401,
  'GET /v1/predictions/:id': 401,
  'POST /v1/predictions/:id/close': 401,
  'POST /v1/decisions': 401,
  'GET /v1/decisions': 401,
  'POST /v1/decisions/:id/supersede': 401,
  'POST /v1/decisions/:id/close': 401,
  'GET /v1/decisions/:id': 401,
  'POST /v1/incidents': 401,
  'GET /v1/incidents': 401,
  'POST /v1/incidents/:id/resolve': 401,
  'POST /v1/incidents/:id/close': 401,
  'GET /v1/incidents/:id': 401,
  'POST /v1/processes': 401,
  'GET /v1/processes': 401,
  'POST /v1/processes/:id/supersede': 401,
  'POST /v1/processes/:id/close': 401,
  'GET /v1/processes/:id': 401,
  'POST /v1/policies': 401,
  'GET /v1/policies': 401,
  'GET /v1/policies/asof': 401,
  'POST /v1/policies/:id/supersede': 401,
  'POST /v1/policies/:id/close': 401,
  'GET /v1/policies/:id': 401,
  'POST /v1/skills': 401,
  'GET /v1/skills': 401,
  'GET /v1/skills/export': 401,
  'POST /v1/skills/:id/supersede': 401,
  'POST /v1/skills/:id/close': 401,
  'GET /v1/skills/:id': 401,
  'POST /v1/project-briefs': 401,
  'GET /v1/project-briefs': 401,
  'POST /v1/project-briefs/refresh': 401,
  'POST /v1/project-briefs/:id/supersede': 401,
  'POST /v1/project-briefs/:id/close': 401,
  'GET /v1/project-briefs/:id': 401,
  'POST /v1/customer-notes': 401,
  'GET /v1/customer-notes': 401,
  'POST /v1/customer-notes/:id/supersede': 401,
  'POST /v1/customer-notes/:id/close': 401,
  'GET /v1/customer-notes/:id': 401,
  // With a secret set, a delivery with no signature header is refused by the signature check.
  'POST /v1/connectors/slack/events': 401,
  'POST /v1/connectors/github/events': 401,
} satisfies Readonly<Record<string, number>>;

// Queries that clear the parsing some routes did before their key check, so the status is the auth outcome on either side of the gate.
const QUERY: ReadonlyMap<string, string> = new Map(
  Object.entries({
    'GET /v1/memories': '?q=x',
    'GET /v1/predictions/stats': '?class=x',
    'GET /v1/policies/asof': '?date=2026-01-01',
  }),
);

describe('the /v1 route table declares every auth need', () => {
  it('gives every row a known auth declaration', () => {
    expect(V1_ROWS.length).toBe(V1_ROUTES.length);
    expect(V1_ROWS.filter(({ route }) => !KNOWN_AUTH.has(route.auth)).map(({ key }) => key)).toEqual([]);
  });

  it('lets only the signed webhooks skip the key check', () => {
    const signed = V1_ROWS.filter(({ route }) => route.auth === 'webhook-signature').map(({ key }) => key);
    expect(signed.sort()).toEqual([...WEBHOOKS].sort());
  });
});

describe('a request with no credential', () => {
  let root: string;
  let handle: ServerHandle;
  const routes = [...new Set([...V1_ROWS.map(({ key }) => key), ...WEBHOOKS])];

  beforeAll(async () => {
    vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '');
    vi.stubEnv('HIPPO_V1_RPS', '0');
    vi.stubEnv('SLACK_SIGNING_SECRET', 'slack-test-secret');
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'github-test-secret');
    root = makeRoot('route-auth-gate');
    initTestStore(root);
    handle = await serve({ hippoRoot: root, port: 0 });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('has an expected status for every route in the table, and none besides', () => {
    expect(Object.keys(NO_CREDENTIAL).sort()).toEqual([...routes].sort());
  });

  it("gets each route's expected status", async () => {
    const seen: Record<string, number> = {};
    for (const key of routes) {
      const [method = '', label = ''] = key.split(' ');
      const res = await fetch(`${handle.url}${label.replace(/:\w+/g, '1')}${QUERY.get(key) ?? ''}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      await res.arrayBuffer();
      seen[key] = res.status;
    }
    expect(seen).toEqual(NO_CREDENTIAL);
  });

  it('is refused before the handler reads its query, so a bad parameter tells an unknown caller nothing', async () => {
    for (const path of ['/v1/graph?limit=0', '/v1/memories', '/v1/audit?op=nope', '/v1/decisions?limit=0']) {
      const res = await fetch(`${handle.url}${path}`);
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });
});
