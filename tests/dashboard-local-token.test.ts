// The dashboard binds loopback, but any local process or user could still read every
// memory through it, so each serve start mints a token the printed URL carries;
// the first page load trades it for a cookie, and every reply pins what a browser may load.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, type Server } from 'node:http';
import { initStore } from '../src/store/open.js';
import { serveDashboard } from '../src/dashboard.js';
import { boundPort } from './_helpers/listen.js';

const TOKEN = 'test-dashboard-token-0123456789';

describe('dashboard local access token', () => {
  let home: string;
  let hippoRoot: string;
  let server: Server | undefined;
  let port: number;
  const prevHippoHome = process.env.HIPPO_HOME;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'hippo-dash-token-'));
    hippoRoot = join(home, '.hippo');
    mkdirSync(hippoRoot, { recursive: true });
    initStore(hippoRoot);
    process.env.HIPPO_HOME = join(home, '.hippo-global');
    server = serveDashboard(hippoRoot, 0, TOKEN);
    port = await boundPort(server);
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    if (prevHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = prevHippoHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses the API and the page without the token', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/api/overview`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/api/overview?token=wrong`)).status).toBe(401);
  });

  it('accepts the token in the query and sets an HttpOnly SameSite=Strict cookie', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/overview?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const pair = cookie.split(';')[0]!;
    expect(pair.endsWith(`=${TOKEN}`)).toBe(true);

    const again = await fetch(`http://127.0.0.1:${port}/api/overview`, { headers: { cookie: pair } });
    expect(again.status).toBe(200);
  });

  it('answers a page load that carries the token with the cookie and a 303 to the same address without it, never to another host', async () => {
    const first = await fetch(`http://127.0.0.1:${port}/memory/abc?tab=links&token=${TOKEN}&q=a%26b`, { redirect: 'manual' });
    expect([first.status, first.headers.get('location')]).toEqual([303, '/memory/abc?tab=links&q=a%26b']);
    const pair = (first.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect((await fetch(`http://127.0.0.1:${port}/api/overview`, { headers: { cookie: pair } })).status).toBe(200);
    const offHost = await fetch(`http://127.0.0.1:${port}//evil.example/x?token=${TOKEN}`, { redirect: 'manual' });
    expect([offHost.status, offHost.headers.get('location')]).toEqual([303, '/x']);
  });

  it('moves a visit another site started off the token URL with a refresh page, since a strict cookie skips that redirect', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/memory/abc?token=${TOKEN}&q=a%26b`, { redirect: 'manual', headers: { 'sec-fetch-site': 'cross-site' } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain(`=${TOKEN}`);
    expect(html).toContain('<meta http-equiv="refresh" content="0;url=/memory/abc?q=a%26b">');
    expect(html).not.toContain(TOKEN);
  });

  it('sends the four security headers on every kind of reply, with a policy that loads code from this server only and that its own page fits', async () => {
    const base = `http://127.0.0.1:${port}`;
    const redirect = await fetch(`${base}/?token=${TOKEN}`, { redirect: 'manual' });
    const signedIn = { headers: { cookie: (redirect.headers.get('set-cookie') ?? '').split(';')[0]! } };
    const page = await fetch(`${base}/`, signedIn);
    const others = [redirect, await fetch(`${base}/api/overview`, signedIn), await fetch(`${base}/api/nope`, signedIn), await fetch(`${base}/`)];
    expect(others.map((r) => r.status)).toEqual([303, 200, 404, 401]);
    const policy = page.headers.get('content-security-policy') ?? '';
    for (const reply of [page, ...others]) {
      expect(['x-content-type-options', 'referrer-policy', 'x-frame-options', 'content-security-policy'].map((name) => reply.headers.get(name)))
        .toEqual(['nosniff', 'no-referrer', 'DENY', policy]);
    }
    const directives = new Map(policy.split('; ').map((d) => [d.split(' ')[0]!, d.split(' ').slice(1)]));
    expect(['default-src', 'script-src', 'connect-src', 'frame-ancestors'].map((name) => directives.get(name)))
      .toEqual([["'none'"], ["'self'"], ["'self'"], ["'none'"]]);
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    // A page that breaks its own policy renders blank: every script comes from a file, every style block is named by hash.
    const html = await page.text();
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect([/\ssrc=/.test(script[1]!), script[2]!.trim()]).toEqual([true, '']);
    }
    for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      expect(policy).toContain(`'sha256-${createHash('sha256').update(style[1]!).digest('base64')}'`);
    }
  });

  it('keeps the Host-header check ahead of the token', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: `/api/overview?token=${TOKEN}`, headers: { host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('prints the dashboard URL with the token once at start', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });
    try {
      const second = serveDashboard(hippoRoot, 0, 'another-token-abcdef');
      const secondPort = await boundPort(second);
      await new Promise((r) => setImmediate(r));
      await new Promise<void>((resolve) => second.close(() => resolve()));
      const withToken = lines.filter((l) => l.includes('token=another-token-abcdef'));
      expect(withToken).toEqual([`Hippo Dashboard running at http://localhost:${secondPort}/?token=another-token-abcdef`]);
    } finally {
      spy.mockRestore();
    }
  });
});
