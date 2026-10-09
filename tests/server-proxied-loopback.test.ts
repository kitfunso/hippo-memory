// A reverse proxy on the same host makes every outside caller look like loopback, so a proxied request must not get no-key admin.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { serve, type ServerHandle } from '../src/server.js';

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
let savedLevel: string | undefined;

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
  savedLevel = process.env.HIPPO_LOG;
  delete process.env.HIPPO_LOG;
  home = mkdtempSync(join(tmpdir(), 'hippo-proxied-loopback-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
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
  rmSync(home, { recursive: true, force: true });
  if (savedLevel === undefined) delete process.env.HIPPO_LOG;
  else process.env.HIPPO_LOG = savedLevel;
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
      expect(await send('/v1/memories?q=deploy', { 'x-forwarded-for': '203.0.113.7', 'x-request-id': 'proxied-1' })).toBe(401);
      const warned = stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[hippo] warn:'));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('requestId=proxied-1');
      expect(warned[0]).toMatch(/proxied loopback request refused/i);
      expect(warned[0]).toMatch(/API key/);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
