import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('refuses to start a second server on a hippoRoot already served (H3)', async () => {
    const home = makeRoot();
    const first = await serve({ hippoRoot: home, port: 0 });
    try {
      // A concurrent `hippo serve` on the same root must be rejected before it
      // can listen or clobber the pidfile.
      await expect(serve({ hippoRoot: home, port: 0 }))
        .rejects.toThrow(/already running/i);

      // The pidfile must still describe the first (real) server, uncorrupted.
      const info = JSON.parse(readFileSync(join(home, 'server.pid'), 'utf8'));
      expect(info.port).toBe(first.port);
      expect(info.pid).toBe(process.pid);
    } finally {
      await first.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects an over-1MB request body with 413 and destroys the socket (M3)', async () => {
    const home = makeRoot();
    const handle = await serve({ hippoRoot: home, port: 0 });
    // Exactly one byte over readBody's 1 MB cap. The +1 matters: the server
    // reads the whole body before `total > cap` trips, so the request is fully
    // consumed and req.destroy() is a clean close (no RST) — the 413 reaches
    // the client deterministically. A larger body leaves the client mid-upload
    // when the socket dies, which fetch cannot resolve into a response.
    const oversize = 'x'.repeat(1024 * 1024 + 1);
    const postOversize = async (path: string): Promise<number> => {
      const res = await fetch(`${handle.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: oversize,
      });
      await res.text().catch(() => { /* body stream may be cut by req.destroy */ });
      return res.status;
    };
    try {
      // The cap lives in readBody, shared by every route — exercise the generic
      // /v1 route and a webhook route, which both call it before any auth.
      expect(await postOversize('/v1/memories')).toBe(413);
      expect(await postOversize('/v1/connectors/slack/events')).toBe(413);
      // The server shed the oversized requests without wedging — still serving.
      const health = await fetch(`${handle.url}/health`);
      expect(health.status).toBe(200);
    } finally {
      await handle.stop();
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

  it('stop() does not remove a pidfile that a newer server rewrote (ownership guard)', async () => {
    const home = makeRoot();
    const handle = await serve({ hippoRoot: home, port: 0 });
    const pidfile = join(home, 'server.pid');
    try {
      // A is live and owns the pidfile. Simulate a newer server B taking over
      // this hippoRoot: overwrite the pidfile with a foreign identity (a
      // different pid AND a different started_at). The forged pid value is
      // arbitrary — removePidfileIfOwned compares it, never probes liveness.
      const forged = {
        schema: 1,
        pid: process.pid + 12345,
        port: handle.port + 1,
        url: `http://127.0.0.1:${handle.port + 1}`,
        started_at: '2099-12-31T23:59:59.000Z',
      };
      writeFileSync(pidfile, JSON.stringify(forged));

      // A shuts down. Its stop() must NOT delete B's pidfile.
      await handle.stop();

      expect(existsSync(pidfile)).toBe(true);
      const after = JSON.parse(readFileSync(pidfile, 'utf8'));
      expect(after.pid).toBe(forged.pid);
      expect(after.started_at).toBe(forged.started_at);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
