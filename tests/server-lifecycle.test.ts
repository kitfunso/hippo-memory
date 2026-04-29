import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../src/server.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-srv-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  return home;
}

describe('server lifecycle', () => {
  it('serve returns a handle with a positive port and matching url', async () => {
    const home = makeRoot();
    const handle = await serve({ hippoRoot: home, port: 0 });
    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);
    } finally {
      await handle.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('GET /health returns 200 with ok, version, started_at, pid', async () => {
    const home = makeRoot();
    const handle = await serve({ hippoRoot: home, port: 0 });
    try {
      const res = await fetch(`${handle.url}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(typeof body.version).toBe('string');
      expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(typeof body.started_at).toBe('string');
      // ISO 8601 sanity check
      expect(Number.isFinite(Date.parse(body.started_at as string))).toBe(true);
      expect(body.pid).toBe(process.pid);
    } finally {
      await handle.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('unknown routes return 404', async () => {
    const home = makeRoot();
    const handle = await serve({ hippoRoot: home, port: 0 });
    try {
      const res = await fetch(`${handle.url}/does-not-exist`);
      expect(res.status).toBe(404);
    } finally {
      await handle.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('stop() removes the pidfile and closes the listener', async () => {
    const home = makeRoot();
    const handle = await serve({ hippoRoot: home, port: 0 });
    const pidfile = join(home, 'server.pid');
    expect(existsSync(pidfile)).toBe(true);

    const port = handle.port;
    await handle.stop();

    expect(existsSync(pidfile)).toBe(false);

    // Listener is closed: a fetch to the old url must fail to connect.
    let connected = false;
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      connected = true;
    } catch {
      connected = false;
    }
    expect(connected).toBe(false);

    rmSync(home, { recursive: true, force: true });
  });

  it('stop() is idempotent (safe to call twice)', async () => {
    const home = makeRoot();
    const handle = await serve({ hippoRoot: home, port: 0 });
    await handle.stop();
    await expect(handle.stop()).resolves.toBeUndefined();
    rmSync(home, { recursive: true, force: true });
  });

  it('full lifecycle: start, health, stop, second start succeeds', async () => {
    const home = makeRoot();

    const first = await serve({ hippoRoot: home, port: 0 });
    const firstHealth = await fetch(`${first.url}/health`);
    expect(firstHealth.status).toBe(200);
    await first.stop();

    const second = await serve({ hippoRoot: home, port: 0 });
    try {
      const secondHealth = await fetch(`${second.url}/health`);
      expect(secondHealth.status).toBe(200);
      const body = await secondHealth.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
    } finally {
      await second.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses to bind to a non-loopback host without auth', async () => {
    const home = makeRoot();
    try {
      await expect(serve({ hippoRoot: home, port: 0, host: '0.0.0.0' }))
        .rejects.toThrow(/auth/i);
      await expect(serve({ hippoRoot: home, port: 0, host: '192.168.1.1' }))
        .rejects.toThrow(/loopback/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
