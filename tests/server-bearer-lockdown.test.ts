// Regression bar: with the loopback no-auth fallback off (HIPPO_REQUIRE_AUTH=1) every
// /v1 and /mcp route must 401 without a valid Bearer. The route list is derived from
// the route table so a new route missing buildContextWithAuth/requireAuth fails here.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initStore } from '../src/store/open.js';
import { serve, type ServerHandle } from '../src/server.js';
import { PUBLIC_ROUTES as PUBLIC } from '../src/server/route-table.js';
import { V1_ROWS } from './_helpers/v1-route-rows.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// The /v1 rows come from the live table; these routes are answered inline in boot.ts's handleRequest, so no table names them.
const INLINE_ROUTES: readonly string[] = ['GET /health', 'GET /ready', 'POST /mcp', 'GET /mcp/stream'];

// Rows the old source-text parse found in the table.
const OLD_PARSED_V1_COUNT = 62;

const derivedRoutes = (): Set<string> => new Set([...V1_ROWS.map((row) => row.key), ...INLINE_ROUTES]);

// Every authed route with a request shape that clears pre-auth validation, so a
// 401 (not 400) proves the Bearer check ran. :param segments become '1'.
const AUTHED_ROUTES: ReadonlyArray<{
  method: string;
  pattern: string;
  query?: string;
  body?: string;
}> = [
  { method: 'POST', pattern: '/v1/memories', body: '{"content":"x"}' },
  { method: 'GET', pattern: '/v1/graph' },
  { method: 'GET', pattern: '/v1/memories', query: '?q=test' },
  { method: 'GET', pattern: '/v1/sessions/:id/assemble' },
  { method: 'GET', pattern: '/v1/recall/drill/:id' },
  { method: 'POST', pattern: '/v1/memories/:id/archive', body: '{"reason":"x"}' },
  { method: 'POST', pattern: '/v1/memories/:id/supersede', body: '{"content":"y"}' },
  { method: 'POST', pattern: '/v1/memories/:id/promote' },
  { method: 'DELETE', pattern: '/v1/memories/:id' },
  { method: 'POST', pattern: '/v1/outcome', body: '{"good":true}' },
  { method: 'GET', pattern: '/v1/context' },
  { method: 'POST', pattern: '/v1/sleep' },
  { method: 'POST', pattern: '/v1/auth/keys', body: '{"label":"x"}' },
  { method: 'GET', pattern: '/v1/auth/keys' },
  { method: 'DELETE', pattern: '/v1/auth/keys/:keyId' },
  { method: 'GET', pattern: '/v1/audit' },
  { method: 'POST', pattern: '/v1/predictions', body: '{"claim":"x","classTag":"y"}' },
  { method: 'GET', pattern: '/v1/predictions' },
  { method: 'GET', pattern: '/v1/predictions/stats', query: '?class=x' },
  { method: 'GET', pattern: '/v1/predictions/:id' },
  { method: 'POST', pattern: '/v1/predictions/:id/close', body: '{"state":"closed"}' },
  { method: 'POST', pattern: '/v1/decisions', body: '{"text":"x"}' },
  { method: 'GET', pattern: '/v1/decisions' },
  { method: 'POST', pattern: '/v1/decisions/:id/supersede', body: '{"text":"x"}' },
  { method: 'POST', pattern: '/v1/decisions/:id/close' },
  { method: 'GET', pattern: '/v1/decisions/:id' },
  { method: 'POST', pattern: '/v1/incidents', body: '{"text":"x"}' },
  { method: 'GET', pattern: '/v1/incidents' },
  { method: 'POST', pattern: '/v1/incidents/:id/resolve', body: '{"resolutionText":"x"}' },
  { method: 'POST', pattern: '/v1/incidents/:id/close' },
  { method: 'GET', pattern: '/v1/incidents/:id' },
  { method: 'POST', pattern: '/v1/processes', body: '{"processName":"x"}' },
  { method: 'GET', pattern: '/v1/processes' },
  { method: 'POST', pattern: '/v1/processes/:id/supersede', body: '{"steps":["x"]}' },
  { method: 'POST', pattern: '/v1/processes/:id/close' },
  { method: 'GET', pattern: '/v1/processes/:id' },
  { method: 'POST', pattern: '/v1/policies', body: '{"policyName":"x","policyText":"y"}' },
  { method: 'GET', pattern: '/v1/policies' },
  { method: 'GET', pattern: '/v1/policies/asof', query: '?date=2026-01-01' },
  { method: 'POST', pattern: '/v1/policies/:id/supersede', body: '{"policyText":"x"}' },
  { method: 'POST', pattern: '/v1/policies/:id/close' },
  { method: 'GET', pattern: '/v1/policies/:id' },
  { method: 'POST', pattern: '/v1/skills', body: '{"skillName":"x","instructions":"y"}' },
  { method: 'GET', pattern: '/v1/skills' },
  { method: 'GET', pattern: '/v1/skills/export' },
  { method: 'POST', pattern: '/v1/skills/:id/supersede', body: '{"instructions":"x"}' },
  { method: 'POST', pattern: '/v1/skills/:id/close' },
  { method: 'GET', pattern: '/v1/skills/:id' },
  { method: 'POST', pattern: '/v1/project-briefs', body: '{"repo":"x","summary":"y"}' },
  { method: 'GET', pattern: '/v1/project-briefs' },
  { method: 'POST', pattern: '/v1/project-briefs/refresh', body: '{"repo":"x"}' },
  { method: 'POST', pattern: '/v1/project-briefs/:id/supersede', body: '{"summary":"x"}' },
  { method: 'POST', pattern: '/v1/project-briefs/:id/close' },
  { method: 'GET', pattern: '/v1/project-briefs/:id' },
  { method: 'POST', pattern: '/v1/customer-notes', body: '{"customer":"x","note":"y"}' },
  { method: 'GET', pattern: '/v1/customer-notes' },
  { method: 'POST', pattern: '/v1/customer-notes/:id/supersede', body: '{"note":"x"}' },
  { method: 'POST', pattern: '/v1/customer-notes/:id/close' },
  { method: 'GET', pattern: '/v1/customer-notes/:id' },
  { method: 'GET', pattern: '/v1/quarantine' },
  { method: 'POST', pattern: '/v1/quarantine/:id/approve' },
  { method: 'POST', pattern: '/v1/quarantine/:id/reject' },
  { method: 'POST', pattern: '/mcp', body: '{"jsonrpc":"2.0","method":"tools/list","id":1}' },
  { method: 'GET', pattern: '/mcp/stream' },
];

function requestPath(pattern: string, query?: string): string {
  const path = pattern.replace(/:\w+/g, '1');
  return query ? `${path}${query}` : path;
}

describe('server Bearer lockdown', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-lockdown-'));
    initStore(root);
    process.env.HIPPO_REQUIRE_AUTH = '1';
    // '0' disables the default limiter (20 rps/burst 40), which would
    // 429 the ~120 /v1 requests this file sends.
    process.env.HIPPO_V1_RPS = '0';
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    delete process.env.HIPPO_REQUIRE_AUTH;
    delete process.env.HIPPO_V1_RPS;
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('every inline method-check in boot.ts handleRequest is a listed inline or public route', () => {
    const boot = readFileSync(join(repoRoot, 'src/server/boot.ts'), 'utf8');
    const inlineChecks = (boot.slice(boot.indexOf('async function handleRequest')).match(/^\s*if \(method === '/gm) ?? []).length;
    expect(inlineChecks).toBe(INLINE_ROUTES.length + PUBLIC.size);
  });

  it('the live /v1 table is at least as large as the 62 rows the old source parse found', () => {
    expect(V1_ROWS.length).toBeGreaterThanOrEqual(OLD_PARSED_V1_COUNT);
  });

  it('PUBLIC_ROUTES contains exactly the two documented unauth routes', () => {
    expect([...PUBLIC].sort()).toEqual([
      'POST /v1/connectors/github/events',
      'POST /v1/connectors/slack/events',
    ]);
  });

  it('AUTHED_ROUTES covers exactly the derived routes minus public routes minus the GET /health and GET /ready probes', () => {
    const expected = derivedRoutes();
    expected.delete('GET /health');
    expected.delete('GET /ready');
    for (const r of PUBLIC) expected.delete(r);

    const actual = new Set(AUTHED_ROUTES.map((r) => `${r.method} ${r.pattern}`));
    const missing = [...expected].filter((r) => !actual.has(r));
    const extra = [...actual].filter((r) => !expected.has(r));
    expect(missing, `AUTHED_ROUTES is missing: ${missing.join(', ')}`).toEqual([]);
    expect(extra, `AUTHED_ROUTES has extra rows not in server.ts: ${extra.join(', ')}`).toEqual([]);
  });

  it('a configured publicJson path needs no Bearer; the unconfigured GET routes beside it still do', async () => {
    await handle.stop();
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0, publicJson: { '/v1/x-public': { ok: true } } });
    const publicUrl = `http://127.0.0.1:${handle.port}/v1/x-public`;
    for (const res of [await fetch(publicUrl), await fetch(publicUrl, { headers: { authorization: 'Bearer hk_invalid.deadbeef' } })]) {
      expect({ status: res.status, body: await res.text() }).toEqual({ status: 200, body: '{"ok":true}' });
    }
    for (const r of AUTHED_ROUTES.filter((route) => route.method === 'GET')) {
      const path = requestPath(r.pattern, r.query);
      const res = await fetch(`http://127.0.0.1:${handle.port}${path}`);
      expect(res.status, `GET ${path} -> ${res.status}: ${await res.text()}`).toBe(401);
    }
  });

  it.each(AUTHED_ROUTES)(
    'requires Bearer: $method $pattern (missing header)',
    async (r) => {
      const init: RequestInit = {
        method: r.method,
        headers: { 'content-type': 'application/json' },
      };
      if (r.body !== undefined) init.body = r.body;
      const path = requestPath(r.pattern, r.query);
      const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, init);
      const text = await res.text();
      expect(res.status, `${r.method} ${path} -> ${res.status}: ${text}`).toBe(401);
    },
  );

  it.each(AUTHED_ROUTES)(
    'requires Bearer: $method $pattern (bad token)',
    async (r) => {
      const init: RequestInit = {
        method: r.method,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer hk_invalid.deadbeef',
        },
      };
      if (r.body !== undefined) init.body = r.body;
      const path = requestPath(r.pattern, r.query);
      const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, init);
      const text = await res.text();
      expect(res.status, `${r.method} ${path} -> ${res.status}: ${text}`).toBe(401);
    },
  );
});
