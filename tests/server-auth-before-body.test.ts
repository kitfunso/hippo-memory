// An authenticated route must reject a bad credential before it reads the body, so an
// unauthenticated caller cannot make the server wait on (or buffer) a large upload.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('auth runs before the request body is read', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-auth-before-body-'));
    initStore(root);
    handle = await serve({ hippoRoot: root, port: 0, selfServiceKeys: { ttlDays: 1, perSubject: 1 } });
  });

  afterEach(async () => {
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

  // The key-mint routes read the body before auth on purpose, so what bounds an unauthenticated caller there is a 4 KB cap.
  it.each(['/v1/auth/keys', '/v1/auth/keys/self'])('POST %s answers 413 for a body over its 4 KB cap', async (path) => {
    const res = await fetch(`${handle.url}${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer hk_bogus.notakey', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x'.repeat(5000) }),
    });
    expect(res.status).toBe(413);
  });
});
