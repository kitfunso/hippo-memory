// The dashboard binds loopback, but any local process or user could still read every
// memory through it, so each start mints a token the URL in dashboard.url carries;
// the first page load trades it for a cookie, and every reply pins what a browser may load.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { printDashboardBanner } from '../src/surface/cli/dashboard-banner.js';
import { serve } from '../src/server.js';
import { serveDashboard } from '../src/surface/server/dashboard-listener.js';
import type { ServerHandle } from '../src/surface/server/types.js';
import { sessionCookie } from './_helpers/dashboard-fixture.js';
import { makeStore } from './_helpers/make-root.js';

const TOKEN = 'test-dashboard-token-0123456789';

describe('dashboard local access token', () => {
  let home: string;
  let hippoRoot: string;
  let server: ServerHandle | undefined;
  let port: number;

  beforeEach(async () => {
    ({ base: home, root: hippoRoot } = makeStore('dash-token'));
    vi.stubEnv('HIPPO_HOME', join(home, '.hippo-global'));
    server = await serveDashboard({ hippoRoot, port: 0, token: TOKEN, tenantId: 'default' });
    port = server.port;
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    vi.unstubAllEnvs();
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
    expect(pair).toBe(sessionCookie(port, TOKEN));

    const again = await fetch(`http://127.0.0.1:${port}/api/overview`, { headers: { cookie: pair } });
    expect(again.status).toBe(200);
  });

  it('sets a cookie that is not the token, and refuses the raw token sent as the cookie', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/overview?token=${TOKEN}`);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).not.toContain(TOKEN);
    expect(cookie.split(';')[0]).toMatch(new RegExp(`^hippo_dashboard_${port}=[0-9a-f]{64}$`));

    const raw = await fetch(`http://127.0.0.1:${port}/api/overview`, {
      headers: { cookie: `hippo_dashboard_${port}=${TOKEN}` },
    });
    expect(raw.status).toBe(401);
    const rawPage = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { cookie: `hippo_dashboard_${port}=${TOKEN}` },
    });
    expect(rawPage.status).toBe(401);
  });

  it('refuses a session cookie minted for another port', async () => {
    const otherPortSession = sessionCookie(port + 1, TOKEN).split('=')[1];
    const res = await fetch(`http://127.0.0.1:${port}/api/overview`, {
      headers: { cookie: `hippo_dashboard_${port}=${otherPortSession}` },
    });
    expect(res.status).toBe(401);
  });

  it('bounds the cookie to one day, so a browser that restores its session does not keep the token forever', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/overview?token=${TOKEN}`);
    expect(res.headers.get('set-cookie')).toMatch(/; Max-Age=86400(;|$)/);
  });

  it('answers a page load that carries the token with the cookie and a 303 to the same address without it, never to another host', async () => {
    const first = await fetch(`http://127.0.0.1:${port}/memory/abc?tab=links&token=${TOKEN}&q=a%26b`, {
      redirect: 'manual',
    });
    expect([first.status, first.headers.get('location')]).toEqual([303, '/memory/abc?tab=links&q=a%26b']);
    const pair = (first.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect((await fetch(`http://127.0.0.1:${port}/api/overview`, { headers: { cookie: pair } })).status).toBe(200);
    const offHost = await fetch(`http://127.0.0.1:${port}//evil.example/x?token=${TOKEN}`, { redirect: 'manual' });
    expect([offHost.status, offHost.headers.get('location')]).toEqual([303, '/x']);
  });

  it('refuses a request another site started before it reads the token, and logs no token', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (const site of ['cross-site', 'same-site']) {
        const res = await fetch(`http://127.0.0.1:${port}/memory/abc?token=${TOKEN}`, {
          redirect: 'manual',
          headers: { 'sec-fetch-site': site },
        });
        expect([res.status, res.headers.get('set-cookie'), await res.json()]).toEqual([
          403,
          null,
          { error: 'cross-site or non-local request refused' },
        ]);
      }
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).not.toContain(TOKEN);
    } finally {
      stderr.mockRestore();
    }
  });

  it('sends the four security headers on every kind of reply, with a policy that loads code from this server only and that its own page fits', async () => {
    const base = `http://127.0.0.1:${port}`;
    const redirect = await fetch(`${base}/?token=${TOKEN}`, { redirect: 'manual' });
    const signedIn = { headers: { cookie: (redirect.headers.get('set-cookie') ?? '').split(';')[0]! } };
    const page = await fetch(`${base}/`, signedIn);
    const others = [
      redirect,
      await fetch(`${base}/api/overview`, signedIn),
      await fetch(`${base}/api/nope`, signedIn),
      await fetch(`${base}/`),
    ];
    expect(others.map((r) => r.status)).toEqual([303, 200, 404, 401]);
    const policy = page.headers.get('content-security-policy') ?? '';
    for (const reply of [page, ...others]) {
      expect(
        ['x-content-type-options', 'referrer-policy', 'x-frame-options', 'content-security-policy'].map((name) =>
          reply.headers.get(name),
        ),
      ).toEqual(['nosniff', 'no-referrer', 'DENY', policy]);
    }
    const directives = new Map(policy.split('; ').map((d) => [d.split(' ')[0]!, d.split(' ').slice(1)]));
    expect(['default-src', 'script-src', 'connect-src', 'frame-ancestors'].map((name) => directives.get(name))).toEqual(
      [["'none'"], ["'self'"], ["'self'"], ["'none'"]],
    );
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

  it('mounts no /v1 API, and its session authenticates nothing on the /v1 server', async () => {
    const minted = await fetch(`http://127.0.0.1:${port}/api/overview?token=${TOKEN}`);
    const pair = (minted.headers.get('set-cookie') ?? '').split(';')[0]!;
    const onDashboard = await fetch(`http://127.0.0.1:${port}/v1/memories?q=x`, { headers: { cookie: pair } });
    expect(onDashboard.headers.get('content-type')).toBe('text/html; charset=utf-8');

    vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '');
    const v1 = await serve({ hippoRoot, port: 0 });
    try {
      const cookie = `${pair}; ${sessionCookie(v1.port, TOKEN)}`;
      const res = await fetch(`${v1.url}/v1/memories?q=x`, { headers: { cookie } });
      expect(res.status).toBe(401);
    } finally {
      await v1.stop();
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

  /** The lines the start banner prints with stdout's isTTY forced to `tty`. */
  function bannerLines(tty: boolean): string[] {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });
    const savedTty = process.stdout.isTTY;
    process.stdout.isTTY = tty;
    try {
      printDashboardBanner(hippoRoot, 4567, 'another-token-abcdef', null);
      return lines;
    } finally {
      process.stdout.isTTY = savedTty;
      spy.mockRestore();
    }
  }

  it.each([true, false])(
    'keeps the token off stdout (a terminal: %s) and writes the full URL to an owner-only file in the hippo root',
    (tty) => {
      const urlFile = join(hippoRoot, 'dashboard.url');
      const lines = bannerLines(tty);
      expect(lines.join('\n')).not.toContain('another-token-abcdef');
      expect(lines).toEqual([
        `Hippo Dashboard running at http://localhost:4567/ (open the URL with its token from ${urlFile})`,
        'Press Ctrl+C to stop.',
      ]);
      expect(existsSync(urlFile)).toBe(true);
      expect(readFileSync(urlFile, 'utf8')).toBe('http://localhost:4567/?token=another-token-abcdef\n');
      if (process.platform !== 'win32') expect(statSync(urlFile).mode & 0o777).toBe(0o600);
    },
  );
});
