// The API server's no-key loopback fallback must refuse a page from another site and a rebound Host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import type { ServerHandle } from '../../src/server.js';
import { serve } from '../_helpers/store-switch.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, readEntry } from '../_helpers/root-forms.js';

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

let home: string;
let handle: ServerHandle;
let id: string;

function send(method: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: handle.port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  home = makeRoot('cross-site');
  const e = createMemory('the deploy runs on fridays');
  writeEntry(home, e);
  id = e.id;
  handle = await serve({ hippoRoot: home, port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await handle.stop();
});

describe('API server loopback fallback', () => {
  it('refuses a cross-site read and leaves the row unread', async () => {
    expect(await send('GET', '/v1/memories?q=deploy', { 'sec-fetch-site': 'cross-site' })).toBe(403);
    expect(readEntry(home, id)!.retrievalCount).toBe(0);
  });

  it('refuses a cross-origin sleep', async () => {
    expect(await send('POST', '/v1/sleep', { origin: 'http://evil.example' })).toBe(403);
  });

  it('refuses a rebound Host', async () => {
    expect(await send('GET', '/v1/memories?q=deploy', { host: `evil.example:${handle.port}` })).toBe(403);
  });

  it('serves a plain local client and a same-origin page', async () => {
    expect(await send('GET', '/v1/memories?q=deploy')).toBe(200);
    const origin = `http://127.0.0.1:${handle.port}`;
    expect(await send('GET', '/v1/memories?q=deploy', { 'sec-fetch-site': 'same-origin', origin })).toBe(200);
  });
});
