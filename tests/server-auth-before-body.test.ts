// An authenticated route must reject a bad credential before it reads the body, so an
// unauthenticated caller cannot make the server wait on (or buffer) a large upload.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { initStore } from '../src/store/open.js';
import { serve, type ServerHandle } from '../src/server.js';

/** Sends headers that promise a 2 MB body plus a few bytes of it, never the rest, and resolves with the status line. */
function statusBeforeBodyArrives(port: number, path: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer hk_bogus.notakey\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${2 * 1024 * 1024}\r\n\r\n{"content":"x`,
      );
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no response within ${timeoutMs} ms: the server is waiting for the body`));
    }, timeoutMs);
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      const eol = data.indexOf('\r\n');
      if (eol >= 0) {
        clearTimeout(timer);
        socket.destroy();
        resolve(data.slice(0, eol));
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Sends headers that promise a body and never the body; resolves with the status line once the server closes the socket. */
function statusUntilServerCloses(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer hk_bogus.notakey\r\n` +
          `Content-Type: application/json\r\nContent-Length: 100\r\n\r\n`,
      );
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString('utf8'); });
    socket.on('close', () => resolve(data.slice(0, Math.max(0, data.indexOf('\r\n')))));
    socket.on('error', reject);
  });
}

/** Real-time wait until something has armed a (faked) timer, so the test fires the deadline instead of sleeping through it. */
async function untilTimerArmed(timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (vi.getTimerCount() === 0) {
    if (Date.now() - started > timeoutMs) throw new Error(`no deadline timer was armed within ${timeoutMs} ms`);
    await new Promise((ok) => setImmediate(ok));
  }
}

describe('no route reads an unauthenticated body beyond a stated cap and deadline', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-auth-before-body-'));
    initStore(root);
    handle = await serve({ hippoRoot: root, port: 0 });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    '/v1/memories',
    '/v1/outcome',
    '/v1/predictions',
    '/v1/decisions',
    '/v1/memories/mem_abc/archive',
    '/v1/project-briefs/refresh',
    '/mcp',
  ])('POST %s answers 401 without waiting for the promised body', async (path) => {
    expect(await statusBeforeBodyArrives(handle.port, path)).toBe('HTTP/1.1 401 Unauthorized');
  });

  // POST /v1/auth/keys reads its body before auth on purpose, so a 4 KB cap and a deadline are what bound an unauthenticated caller there.
  it('POST /v1/auth/keys answers 413 for a body over its 4 KB cap', async () => {
    const res = await fetch(`${handle.url}/v1/auth/keys`, {
      method: 'POST',
      headers: { authorization: 'Bearer hk_bogus.notakey', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x'.repeat(5000) }),
    });
    expect(res.status).toBe(413);
  });

  it('POST /v1/auth/keys answers 408 and drops the socket when the promised body never arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const answered = statusUntilServerCloses(handle.port, '/v1/auth/keys');
    await untilTimerArmed();
    vi.runOnlyPendingTimers();
    expect(await answered).toBe('HTTP/1.1 408 Request Timeout');
  });
});
