// Regression bar: with the loopback no-auth fallback off (HIPPO_REQUIRE_AUTH=1) every
// /v1 and /mcp route must 401 without a valid Bearer. The route list is derived from
// src/server.ts so a new route missing buildContextWithAuth/requireAuth fails here.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initStore } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Parses the three route shapes handleRequest uses into 'METHOD /pattern'
// keys, so completeness below catches a route missing its auth call.
function routesFromServerSource(text: string): Set<string> {
  const lines = text.split('\n');
  const routes = new Set<string>();
  const literalRe = /method === '([A-Z]+)' && path === '([^']+)'/;
  const matchAssignRe = /const (\w+) = matchPath\('([^']+)', path\);/;
  const regexAssignRe = /const (\w+) = path\.match\(\/\^(.+?)\$\/\);/;

  const methodForVar = (startLine: number, varName: string): string | undefined => {
    for (let j = startLine + 1; j < Math.min(startLine + 6, lines.length); j++) {
      const m = lines[j].match(new RegExp(`method === '([A-Z]+)' && [^\\n]*\\b${varName}\\b`));
      if (m) return m[1];
    }
    return undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lit = line.match(literalRe);
    if (lit) {
      routes.add(`${lit[1]} ${lit[2]}`);
      continue;
    }
    const ma = line.match(matchAssignRe);
    if (ma) {
      const [, varName, pattern] = ma;
      const method = methodForVar(i, varName);
      if (method) routes.add(`${method} ${pattern}`);
      continue;
    }
    const ra = line.match(regexAssignRe);
    if (ra) {
      const [, varName, rawPattern] = ra;
      const pattern = rawPattern.replace(/\\\//g, '/').replace(/\(\\d\+\)/g, ':id');
      const method = methodForVar(i, varName);
      if (method) routes.add(`${method} ${pattern}`);
      continue;
    }
  }
  return routes;
}

// Parses the PUBLIC_ROUTES Set literal in server.ts source.
function publicRoutesFromServerSource(text: string): Set<string> {
  const m = text.match(/const PUBLIC_ROUTES: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\);/);
  if (!m) throw new Error('PUBLIC_ROUTES literal not found in server.ts');
  const routes = new Set<string>();
  const entryRe = /'([^']+)'/g;
  let entry: RegExpExecArray | null;
  while ((entry = entryRe.exec(m[1])) !== null) {
    routes.add(entry[1]);
  }
  return routes;
}

const serverSource = readFileSync(join(repoRoot, 'src/server.ts'), 'utf8');
const handleRequestSource = serverSource.slice(serverSource.indexOf('async function handleRequest'));

// Every authed (non-public, non-health) route with a request shape that
// clears pre-auth validation, so a 401 (not 400) proves the Bearer check ran.
// :param segments become '1' (ID_SEGMENT_RE and \d+ regex routes both accept it).
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

  it('the three raw route shapes account for every parsed entry (guards a 4th shape)', () => {
    const literalCount = (handleRequestSource.match(/path === '\//g) ?? []).length;
    const matchPathCount = (handleRequestSource.match(/= matchPath\(/g) ?? []).length;
    const regexCount = (handleRequestSource.match(/path\.match\(\/\^/g) ?? []).length;
    const derived = routesFromServerSource(serverSource);
    expect(
      literalCount + matchPathCount + regexCount,
      `raw shape count (${literalCount} + ${matchPathCount} + ${regexCount}) must equal parsed routes (${derived.size})`,
    ).toBe(derived.size);
  });

  it('PUBLIC_ROUTES contains exactly the two documented unauth routes', () => {
    const publicRoutes = publicRoutesFromServerSource(serverSource);
    expect([...publicRoutes].sort()).toEqual([
      'POST /v1/connectors/github/events',
      'POST /v1/connectors/slack/events',
    ]);
  });

  it('AUTHED_ROUTES covers exactly the derived routes minus public routes minus GET /health', () => {
    const derived = routesFromServerSource(serverSource);
    const publicRoutes = publicRoutesFromServerSource(serverSource);
    const expected = new Set(derived);
    expected.delete('GET /health');
    for (const r of publicRoutes) expected.delete(r);

    const actual = new Set(AUTHED_ROUTES.map((r) => `${r.method} ${r.pattern}`));
    const missing = [...expected].filter((r) => !actual.has(r));
    const extra = [...actual].filter((r) => !expected.has(r));
    expect(missing, `AUTHED_ROUTES is missing: ${missing.join(', ')}`).toEqual([]);
    expect(extra, `AUTHED_ROUTES has extra rows not in server.ts: ${extra.join(', ')}`).toEqual([]);
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
