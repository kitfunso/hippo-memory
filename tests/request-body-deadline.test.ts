// A caller that passes auth, promises a body and then stalls must get a 408 and lose its socket, on every route that reads a body.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { connect } from 'node:net';
import { serve, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';
import { DASHBOARD_TOKEN, makeStore, seed, startDashboard, type RunningDashboard, type TmpStore } from './_helpers/dashboard-fixture.js';

const GIVE_UP_MS = 5000;

/** Sends headers that promise 100 bytes plus `sent`, never the rest; resolves with the status line once the server closes the socket. */
function statusOfStalledPost(port: number, path: string, extraHeaders = '', sent = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n${extraHeaders}Content-Length: 100\r\n\r\n${sent}`,
      );
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no reply within ${GIVE_UP_MS} ms: the server is still waiting for the body`));
    }, GIVE_UP_MS);
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString('utf8'); });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(data.slice(0, Math.max(0, data.indexOf('\r\n'))));
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

beforeEach(() => {
  process.env.HIPPO_BODY_TIMEOUT_MS = '150';
});
afterEach(() => {
  delete process.env.HIPPO_BODY_TIMEOUT_MS;
});

describe('hippo serve and a request body that never arrives', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = makeRoot('body-deadline');
    handle = await serve({ hippoRoot: root, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    '/mcp',
    '/v1/memories',
    '/v1/outcome',
    '/v1/sleep',
  ])('POST %s answers 408 and closes the socket', async (path) => {
    expect(await statusOfStalledPost(handle.port, path)).toBe('HTTP/1.1 408 Request Timeout');
  });

  it('answers 408 to a body that starts and then stalls', async () => {
    expect(await statusOfStalledPost(handle.port, '/mcp', '', '{"jsonrpc":"2.0",')).toBe('HTTP/1.1 408 Request Timeout');
  });

  it('still serves the next request, and a body that arrives in time', async () => {
    await statusOfStalledPost(handle.port, '/mcp');
    const res = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    const body: { result?: { tools?: unknown[] } } = await res.json();
    expect(body.result?.tools?.length).toBeGreaterThan(0);
  });
});

describe('hippo dashboard and an action body that never arrives', () => {
  let store: TmpStore;
  let dash: RunningDashboard;

  beforeEach(async () => {
    store = makeStore('hippo-dash-body-deadline');
    dash = await startDashboard(store.hippoRoot);
  });

  afterEach(async () => {
    await dash.close();
    store.cleanup();
  });

  it('answers 408 and closes the socket', async () => {
    const target = seed(store.hippoRoot, 'a row to pin');
    const cookie = `Cookie: hippo_dashboard_${dash.port}=${DASHBOARD_TOKEN}\r\n`;
    expect(await statusOfStalledPost(dash.port, `/api/memory/${target.id}/pin`, cookie)).toBe('HTTP/1.1 408 Request Timeout');
  });
});
