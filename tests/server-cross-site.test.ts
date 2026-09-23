// The API server's no-key loopback fallback must refuse a page from another site and a rebound Host.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/memory.js';
import { initStore, writeEntry, readEntry } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';

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
  home = mkdtempSync(join(tmpdir(), 'hippo-cross-site-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  const e = createMemory('the deploy runs on fridays');
  writeEntry(home, e);
  id = e.id;
  handle = await serve({ hippoRoot: home, port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('API server loopback fallback', () => {
  it('refuses a cross-site read and leaves the row unread', async () => {
    expect(await send('GET', '/v1/memories?q=deploy', { 'sec-fetch-site': 'cross-site' })).toBe(403);
    expect(readEntry(home, id)!.retrieval_count).toBe(0);
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
