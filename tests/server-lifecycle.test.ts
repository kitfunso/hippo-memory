import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../src/server.js';

// Not initStore'd on purpose: these tests start from an empty `.hippo` dir.
function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-srv-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  return home;
}

interface HealthBody {
  ok: boolean;
  version: string;
  started_at: string;
  pid: number;
  audit_write_failures: number;
}

/**
 * Parses a /health response body as HealthBody.
 * SAFETY: every call site reads the body from this file's own /health
 * fetches, immediately followed by runtime assertions on each field.
 */
async function healthBody(res: Response): Promise<HealthBody> {
  // SAFETY: see doc comment above — every call site asserts on HealthBody's
  // fields immediately after calling healthBody.
  return (await res.json()) as HealthBody;
}

interface UploadReply {
  status: number;
  body: string;
  closed: Promise<void>;
}

// Unpaced and never ended, as a large upload is, so only the server can close the connection.
function uploadUnpaced(port: number, path: string, headers: Record<string, string> = {}): Promise<UploadReply> {
  const chunk = Buffer.alloc(64 * 1024, 'x');
  return new Promise<UploadReply>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } });
    let answered = false;
    req.on('response', (res) => {
      answered = true;
      const socket = req.socket;
      const closed = socket === null || socket.destroyed
        ? Promise.resolve()
        : new Promise<void>((done) => socket.once('close', () => done()));
      const parts: Buffer[] = [];
      res.on('data', (part: Buffer) => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8'), closed }));
      res.on('error', reject);
    });
    // A reset before the reply is read is the bug this guards: the server closed with request bytes unread.
    req.on('error', (err) => {
      if (!answered) reject(err);
    });
    const send = async (): Promise<void> => {
      for (let sent = 0; sent < 8 * 1024 * 1024 && !req.destroyed && !answered; sent += chunk.length) {
        await new Promise<void>((done) => req.write(chunk, () => done()));
      }
    };
    void send();
  });
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
      const body = await healthBody(res);
      expect(body.ok).toBe(true);
      expect(body.version).toEqual(expect.any(String));
      expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(body.started_at).toEqual(expect.any(String));
      // ISO 8601 sanity check
      expect(Number.isFinite(Date.parse(body.started_at))).toBe(true);
      expect(body.pid).toBe(process.pid);
      expect(body.audit_write_failures).toEqual(expect.any(Number));
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

  it('logs a listener error raised after boot and keeps serving', async () => {
    const home = makeRoot();
    const handle = await serve({ hippoRoot: home, port: 0 });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // What Node emits when accept() fails, as it does when the process runs out of file descriptors.
      handle.server?.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' }));
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toMatch(/^\[hippo\] error: serve: listener error: accept EMFILE /);
      expect((await fetch(`${handle.url}/health`)).status).toBe(200);
    } finally {
      stderr.mockRestore();
      await handle.stop();
      rmSync(home, { recursive: true, force: true });
    }
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
      const body = await healthBody(secondHealth);
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

  it('answers an upload still streaming past 1 MB with its 413, then closes the connection (M3)', async () => {
    const home = makeRoot();
    const handle = await serve({ hippoRoot: home, port: 0 });
    try {
      // The cap lives in readBody, shared by every route: the generic /v1 route reads a body
      // before any key check, and a webhook route reads one once a secret and a signature header are there.
      process.env.SLACK_SIGNING_SECRET = 'test-only-webhook-signing-material';
      const signed = { 'x-slack-signature': 'v0=00', 'x-slack-request-timestamp': '1' };
      for (const [path, headers] of [['/v1/memories', {}], ['/v1/connectors/slack/events', signed]] as const) {
        const reply = await uploadUnpaced(handle.port, path, headers);
        expect(reply.status).toBe(413);
        expect(JSON.parse(reply.body)).toEqual({ error: 'request body exceeds 1MB' });
        await reply.closed;
      }
      // A webhook with no secret configured reads nothing, and still drops the uploader.
      delete process.env.SLACK_SIGNING_SECRET;
      const unconfigured = await uploadUnpaced(handle.port, '/v1/connectors/slack/events', signed);
      expect(unconfigured.status).toBe(404);
      await unconfigured.closed;
      // The server shed the oversized requests without wedging — still serving.
      const health = await fetch(`${handle.url}/health`);
      expect(health.status).toBe(200);
    } finally {
      delete process.env.SLACK_SIGNING_SECRET;
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

describe('/v1 rate limiting', () => {
  it('throttles /v1/* with 429s and never throttles /health', async () => {
    const home = makeRoot();
    const prev = process.env.HIPPO_V1_RPS;
    process.env.HIPPO_V1_RPS = '1'; // rate 1/s, burst 2
    try {
      const handle = await serve({ hippoRoot: home, port: 0 });
      try {
        // A burst of 12 /v1/ requests far exceeds burst=2 — some must be 429.
        const v1 = await Promise.all(
          Array.from({ length: 12 }, () => fetch(`${handle.url}/v1/memories?q=x`)),
        );
        expect(v1.some((r) => r.status === 429)).toBe(true);
        // /health is not a /v1/ path: never throttled.
        const health = await Promise.all(
          Array.from({ length: 12 }, () => fetch(`${handle.url}/health`)),
        );
        expect(health.every((r) => r.status === 200)).toBe(true);
      } finally {
        await handle.stop();
      }
    } finally {
      if (prev === undefined) delete process.env.HIPPO_V1_RPS;
      else process.env.HIPPO_V1_RPS = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('throttles /mcp and /mcp/stream from the same per-IP bucket', async () => {
    const home = makeRoot();
    const prev = process.env.HIPPO_V1_RPS;
    process.env.HIPPO_V1_RPS = '1'; // rate 1/s, burst 2
    const ac = new AbortController();
    try {
      const handle = await serve({ hippoRoot: home, port: 0 });
      try {
        const mcp = await Promise.all(
          Array.from({ length: 12 }, () => fetch(`${handle.url}/mcp`, { method: 'POST', body: '{}' })),
        );
        expect(mcp.some((r) => r.status === 429)).toBe(true);
        const stream = await fetch(`${handle.url}/mcp/stream`, { signal: ac.signal });
        expect(stream.status).toBe(429);
      } finally {
        ac.abort();
        await handle.stop();
      }
    } finally {
      if (prev === undefined) delete process.env.HIPPO_V1_RPS;
      else process.env.HIPPO_V1_RPS = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('HIPPO_V1_RPS=0 disables the limiter (no 429s under a burst)', async () => {
    const home = makeRoot();
    const prev = process.env.HIPPO_V1_RPS;
    process.env.HIPPO_V1_RPS = '0';
    try {
      const handle = await serve({ hippoRoot: home, port: 0 });
      try {
        const v1 = await Promise.all(
          Array.from({ length: 12 }, () => fetch(`${handle.url}/v1/memories?q=x`)),
        );
        expect(v1.some((r) => r.status === 429)).toBe(false);
      } finally {
        await handle.stop();
      }
    } finally {
      if (prev === undefined) delete process.env.HIPPO_V1_RPS;
      else process.env.HIPPO_V1_RPS = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
