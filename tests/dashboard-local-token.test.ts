// The dashboard binds loopback, but any local process or user could still read every
// memory through it, so each serve start mints a token the printed URL carries.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, type Server } from 'node:http';
import { initStore } from '../src/store.js';
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
    expect((await fetch(`http://127.0.0.1:${port}/api/stats`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/api/stats?token=wrong`)).status).toBe(401);
  });

  it('accepts the token in the query and sets an HttpOnly SameSite=Strict cookie', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stats?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const pair = cookie.split(';')[0]!;
    expect(pair.endsWith(`=${TOKEN}`)).toBe(true);

    const again = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie: pair } });
    expect(again.status).toBe(200);
  });

  it('keeps the Host-header check ahead of the token', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: `/api/stats?token=${TOKEN}`, headers: { host: 'evil.example' } },
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
