// Every API response carries an X-Request-Id, the caller's when it is a sane token, else a fresh one, and tells a browser not to guess its type.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { serve, type ServerHandle } from '../src/server.js';

let home: string;
let handle: ServerHandle;
let savedLevel: string | undefined;

function send(path: string, headers: Record<string, string> = {}): Promise<{ status: number; requestId: string | undefined; sniffing: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: handle.port, method: 'GET', path, headers }, (res) => {
      res.resume();
      res.on('end', () => {
        const id = res.headers['x-request-id'];
        const sniffing = res.headers['x-content-type-options'];
        resolve({ status: res.statusCode ?? 0, requestId: Array.isArray(id) ? id[0] : id, sniffing: Array.isArray(sniffing) ? sniffing[0] : sniffing });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  savedLevel = process.env.HIPPO_LOG;
  home = mkdtempSync(join(tmpdir(), 'hippo-request-id-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  handle = await serve({ hippoRoot: home, port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
  if (savedLevel === undefined) delete process.env.HIPPO_LOG;
  else process.env.HIPPO_LOG = savedLevel;
});

describe('X-Content-Type-Options', () => {
  it('is nosniff on data, refused and unknown-route replies, since memory text is caller-written', async () => {
    const replies = [await send('/v1/memories?q=x'), await send('/v1/memories?q=x', { authorization: 'Bearer hk_not_a_real_key' }), await send('/nope')];
    expect(replies.map((r) => [r.status, r.sniffing])).toEqual([[200, 'nosniff'], [401, 'nosniff'], [404, 'nosniff']]);
  });
});

describe('X-Request-Id', () => {
  it('echoes a sane caller id', async () => {
    const res = await send('/health', { 'x-request-id': 'trace-42.a:b_c' });
    expect(res.status).toBe(200);
    expect(res.requestId).toBe('trace-42.a:b_c');
  });

  it('generates a fresh id per request when none is sent', async () => {
    const a = await send('/health');
    const b = await send('/health');
    expect(a.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.requestId).not.toBe(b.requestId);
  });

  it('replaces an id with unsafe characters or excess length', async () => {
    for (const bad of ['has space', 'x'.repeat(129), '<script>']) {
      const res = await send('/health', { 'x-request-id': bad });
      expect(res.requestId).not.toBe(bad);
      expect(res.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('rides on error responses and the failure log line', async () => {
    process.env.HIPPO_LOG = 'info';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // An encoded slash is refused by a thrown HttpError, so it reaches the server's failure path.
      const res = await send('/v1/memories/a%2Fb', { 'x-request-id': 'req-err-1' });
      expect(res.status).toBe(400);
      expect(res.requestId).toBe('req-err-1');
      const logged = stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('requestId=req-err-1'));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatch(/^\[hippo\] info: GET \/v1\/memories\/a%2Fb failed: .* requestId=req-err-1 status=400\n$/);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('rides, with a timestamp, on a line logged below the route by code that was never handed the id', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // A bad value makes the config reader warn from inside the request.
      writeFileSync(join(home, 'config.json'), JSON.stringify({ pilot: { holdoutRateBp: -1 } }));
      await send('/v1/context?q=anything', { 'x-request-id': 'req-deep-1' });
      const warned = stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"pilot"'));
      expect(warned.join('')).toMatch(/^\[hippo\] warn: .* ts=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z requestId=req-deep-1\n/);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
