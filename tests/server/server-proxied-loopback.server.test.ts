// A reverse proxy on the same host makes every outside caller look like loopback, so a proxied request must not get no-key admin.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/sqlite/auth.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const PROXY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Forwarded', 'for=203.0.113.7;proto=https'],
  ['X-Forwarded-For', '203.0.113.7'],
  ['X-Forwarded-Host', 'hippo.example.com'],
  ['X-Forwarded-Proto', 'https'],
  ['X-Real-IP', '203.0.113.7'],
  ['Cf-Connecting-Ip', '203.0.113.7'],
  ['True-Client-Ip', '203.0.113.7'],
  ['Fly-Client-Ip', '203.0.113.7'],
];

let home: string;
let handle: ServerHandle;
let apiKey: string;

function send(path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: handle.port, method: 'GET', path, headers }, (res) => {
      // The SSE route never ends on its own, so the status line is the whole answer.
      resolve(res.statusCode ?? 0);
      res.destroy();
    });
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  vi.stubEnv('HIPPO_LOG', undefined);
  home = makeRoot('proxied-loopback');
  const db = openHippoDb(home);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'proxied-loopback' }).plaintext;
  } finally {
    closeHippoDb(db);
  }
  handle = await serve({ hippoRoot: home, port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await handle.stop();
});

describe('loopback fallback behind a reverse proxy', () => {
  it.each(PROXY_HEADERS)('refuses a no-key request carrying %s', async (name, value) => {
    expect(await send('/v1/memories?q=deploy', { [name]: value })).toBe(401);
    expect(await send('/mcp/stream', { [name]: value })).toBe(401);
  });

  it.each(PROXY_HEADERS)('serves a keyed request carrying %s', async (name, value) => {
    expect(await send('/v1/memories?q=deploy', { [name]: value, authorization: `Bearer ${apiKey}` })).toBe(200);
  });

  it('still serves a direct loopback request with no key', async () => {
    expect(await send('/v1/memories?q=deploy')).toBe(200);
  });

  it('logs one warn line with the request id and the fix', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(
        await send('/v1/memories?q=deploy', { 'x-forwarded-for': '203.0.113.7', 'x-request-id': 'proxied-1' }),
      ).toBe(401);
      const warned = stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[hippo] warn:'));
      // The refused request's 401 also warns, so count the proxy line by its text.
      const proxied = warned.filter((l) => /proxied loopback request refused/i.test(l));
      expect(proxied).toHaveLength(1);
      expect(warned.filter((l) => !proxied.includes(l)).every((l) => l.includes('status=401'))).toBe(true);
      expect(proxied[0]).toContain('requestId=proxied-1');
      expect(proxied[0]).toMatch(/proxied loopback request refused/i);
      expect(proxied[0]).toMatch(/API key/);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
