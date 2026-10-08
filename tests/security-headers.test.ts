// The dashboard shows memory text other tools wrote, so its replies pin what a browser may load, and the access token leaves the URL on the first page load.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { serveDashboard } from '../src/dashboard.js';
import { serve, type ServerHandle } from '../src/server.js';
import { boundPort } from './_helpers/listen.js';
import { makeStore, type TmpStore } from './_helpers/dashboard-fixture.js';
import { makeRoot } from './_helpers/make-root.js';

const TOKEN = 'test-dashboard-token-0123456789';

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** One request with no redirect following, so a 303 is seen as a 303. */
function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('dashboard', () => {
  let store: TmpStore;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    store = makeStore('hippo-dash-headers');
    server = serveDashboard(store.hippoRoot, 0, TOKEN);
    port = await boundPort(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.cleanup();
  });

  const cookie = () => ({ cookie: `hippo_dashboard_${port}=${TOKEN}` });

  it('sends the four security headers on every kind of reply', async () => {
    const replies = {
      page: await get(port, '/', cookie()),
      api: await get(port, '/api/overview', cookie()),
      apiNotFound: await get(port, '/api/nope', cookie()),
      badRequest: await get(port, '/api/memory/%E0%A4%A', cookie()),
      noToken: await get(port, '/'),
      foreignHost: await get(port, '/', { host: 'evil.example' }),
      redirect: await get(port, `/?token=${TOKEN}`),
    };
    expect(Object.fromEntries(Object.entries(replies).map(([name, r]) => [name, r.status]))).toMatchObject({
      api: 200, apiNotFound: 404, badRequest: 400, noToken: 401, foreignHost: 403, redirect: 303,
    });
    for (const [name, reply] of Object.entries(replies)) {
      expect(reply.headers['x-content-type-options'], name).toBe('nosniff');
      expect(reply.headers['referrer-policy'], name).toBe('no-referrer');
      expect(reply.headers['x-frame-options'], name).toBe('DENY');
      expect(reply.headers['content-security-policy'], name).toBeTypeOf('string');
    }
  });

  it('allows scripts, styles, fonts and fetches from this server only, and no framing', async () => {
    const policy = String((await get(port, '/', cookie())).headers['content-security-policy']);
    const directives = new Map(policy.split('; ').map((d) => [d.split(' ')[0]!, d.split(' ').slice(1)]));
    expect(directives.get('default-src')).toEqual(["'none'"]);
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('connect-src')).toEqual(["'self'"]);
    expect(directives.get('font-src')).toEqual(["'self'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'none'"]);
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it('serves a page its own policy allows: no inline script, no style attribute, every style block named by hash', async () => {
    const page = await get(port, '/', cookie());
    const policy = String(page.headers['content-security-policy']);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).not.toMatch(/\sstyle\s*=/i);
    expect(page.body).not.toMatch(/\son[a-z]+\s*=/i);
    for (const script of page.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(script[1]).toMatch(/\ssrc=/);
      expect(script[2]!.trim()).toBe('');
    }
    for (const style of page.body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      expect(policy).toContain(`'sha256-${createHash('sha256').update(style[1]!).digest('base64')}'`);
    }
  });

  it('answers a page load that carries the token with the cookie and a 303 to the same address without it', async () => {
    const first = await get(port, `/?token=${TOKEN}`);
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe('/');
    const pair = String(first.headers['set-cookie']?.[0]).split(';')[0]!;
    expect(pair).toBe(`hippo_dashboard_${port}=${TOKEN}`);
    expect(String(first.headers['set-cookie']?.[0])).toMatch(/HttpOnly; SameSite=Strict/);
    expect((await get(port, first.headers.location!, { cookie: pair })).status).not.toBe(401);
  });

  it('keeps the path and the other query fields, and never redirects to another host', async () => {
    expect((await get(port, `/memory/abc?tab=links&token=${TOKEN}&q=a%26b`)).headers.location).toBe('/memory/abc?tab=links&q=a%26b');
    expect((await get(port, `//evil.example/x?token=${TOKEN}`)).headers.location).toBe('/x');
    expect((await get(port, `/.//evil.example/x?token=${TOKEN}`)).headers.location).toBe('/evil.example/x');
    expect((await get(port, `/\\evil.example/x?token=${TOKEN}`)).headers.location).toBe('/x');
    expect((await get(port, `/%5Cevil.example?token=${TOKEN}`)).headers.location).toBe('/%5Cevil.example');
    expect((await get(port, `/?token=${TOKEN}`, {}, 'HEAD')).status).toBe(303);
  });

  it('answers an API call that carries the token in place, and does not redirect a wrong token', async () => {
    expect((await get(port, `/api/overview?token=${TOKEN}`)).status).toBe(200);
    const wrong = await get(port, '/?token=wrong');
    expect(wrong.status).toBe(401);
    expect(wrong.headers.location).toBeUndefined();
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('moves a visit another site started off the token URL with a same-site refresh, since a strict cookie skips that redirect', async () => {
    const reply = await get(port, `/memory/abc?token=${TOKEN}&q=a%26b`, { 'sec-fetch-site': 'cross-site' });
    expect(reply.status).toBe(200);
    expect(reply.headers['set-cookie']?.[0]).toContain(`hippo_dashboard_${port}=${TOKEN}`);
    expect(reply.body).toContain('<meta http-equiv="refresh" content="0;url=/memory/abc?q=a%26b">');
    expect(reply.body).not.toContain(TOKEN);
    expect(reply.body).not.toMatch(/<script/i);
  });
});

describe('hippo serve', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = makeRoot('nosniff');
    handle = await serve({ hippoRoot: root, port: 0, publicJson: { '/v1/x-public': { ok: true } } });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('marks every reply nosniff: health, data, public JSON, MCP, not found and refused', async () => {
    const replies = {
      health: await get(handle.port, '/health'),
      recall: await get(handle.port, '/v1/memories?q=x'),
      publicJson: await get(handle.port, '/v1/x-public'),
      mcp: await get(handle.port, '/mcp', { 'content-type': 'application/json' }, 'POST'),
      notFound: await get(handle.port, '/nope'),
      refused: await get(handle.port, '/v1/memories?q=x', { authorization: 'Bearer hk_not_a_real_key' }),
      webhookOff: await get(handle.port, '/v1/connectors/slack/events', {}, 'POST'),
    };
    expect(Object.fromEntries(Object.entries(replies).map(([name, r]) => [name, r.status]))).toMatchObject({
      health: 200, recall: 200, publicJson: 200, notFound: 404, refused: 401, webhookOff: 404,
    });
    for (const [name, reply] of Object.entries(replies)) {
      expect(reply.headers['x-content-type-options'], name).toBe('nosniff');
    }
  });
});
