// No unauthenticated caller can make the server buffer a large body or wait long for one: every keyed route checks
// the credential before it reads. The two webhook routes take no API key, so they check the signing secret and the signature headers first.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { connect } from 'node:net';
import { serve, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { createApiKey } from '../src/store/auth.js';

/** An admin key, since only an admin passes the mint route's gate to its body read. */
function adminKey(root: string): string {
  const db = openHippoDb(root);
  try {
    return createApiKey(db, { tenantId: 'default', label: 'mint-body', role: 'admin' }).plaintext;
  } finally {
    closeHippoDb(db);
  }
}

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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
function statusUntilServerCloses(port: number, path: string, credential = 'Authorization: Bearer hk_bogus.notakey\r\n'): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${credential}` +
          `Content-Type: application/json\r\nContent-Length: 100\r\n\r\n`,
      );
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString('utf8'); });
    socket.on('close', () => resolve(data.slice(0, Math.max(0, data.indexOf('\r\n')))));
    socket.on('error', reject);
  });
}

const WEBHOOKS = [
  ['/v1/connectors/slack/events', 'SLACK_SIGNING_SECRET', 'X-Slack-Signature: v0=00\r\nX-Slack-Request-Timestamp: 1\r\n'],
  ['/v1/connectors/github/events', 'GITHUB_WEBHOOK_SECRET', `X-Hub-Signature-256: sha256=${'0'.repeat(64)}\r\n`],
] as const;

describe('no route reads an unauthenticated body beyond a stated cap and deadline', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = makeRoot('auth-before-body');
    handle = await serve({ hippoRoot: root, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
  });

  it.each([
    '/v1/memories',
    '/v1/outcome',
    '/v1/predictions',
    '/v1/decisions',
    '/v1/memories/mem_abc/archive',
    '/v1/project-briefs/refresh',
    '/v1/auth/keys',
    '/mcp',
  ])('POST %s answers 401 without waiting for the promised body', async (path) => {
    expect(await statusBeforeBodyArrives(handle.port, path)).toBe('HTTP/1.1 401 Unauthorized');
  });

  // Past the admin gate the key mint still reads under its own 4 KB cap and short deadline.
  it('POST /v1/auth/keys answers 413 for a body over its 4 KB cap', async () => {
    const res = await fetch(`${handle.url}/v1/auth/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminKey(root)}` },
      body: JSON.stringify({ label: 'x'.repeat(5000) }),
    });
    expect(res.status).toBe(413);
  });

  it('POST /v1/auth/keys answers 408 and drops the socket when an accepted caller never sends the promised body', async () => {
    await handle.stop();
    handle = await serve({ hippoRoot: root, port: 0, mintBodyDeadlineMs: 50 });
    const credential = `Authorization: Bearer ${adminKey(root)}\r\n`;
    expect(await statusUntilServerCloses(handle.port, '/v1/auth/keys', credential)).toBe('HTTP/1.1 408 Request Timeout');
  });

  // Past auth (a keyless loopback store accepts the caller) every other route reads through one shared reader, so one route stands for all.
  it('POST /mcp answers 408 and drops the socket when an accepted caller never sends the promised body', async () => {
    vi.stubEnv('HIPPO_BODY_TIMEOUT_MS', '50');
    try {
      expect(await statusUntilServerCloses(handle.port, '/mcp', '')).toBe('HTTP/1.1 408 Request Timeout');
    } finally {
      vi.stubEnv('HIPPO_BODY_TIMEOUT_MS', undefined);
    }
  });

  // A webhook's credential is its signature, so the signature headers stand where the bearer token does.
  it.each(WEBHOOKS)('POST %s drops a caller whose body never arrives: 404 with no signing secret, 401 with no signature, 408 once a signed body stalls', async (path, secretEnv, signatureHeaders) => {
    await handle.stop();
    handle = await serve({ hippoRoot: root, port: 0, webhookBodyDeadlineMs: 50 });
    vi.stubEnv(secretEnv, undefined);
    expect(await statusUntilServerCloses(handle.port, path, signatureHeaders)).toBe('HTTP/1.1 404 Not Found');
    // Test-only signing material, not a real secret.
    vi.stubEnv(secretEnv, 'test-only-webhook-signing-material');
    expect(await statusUntilServerCloses(handle.port, path, '')).toBe('HTTP/1.1 401 Unauthorized');
    expect(await statusUntilServerCloses(handle.port, path, signatureHeaders)).toBe('HTTP/1.1 408 Request Timeout');
  });

  it('POST /v1/connectors/github/events answers 401 to a signature header that is no SHA-256 digest, without waiting for the body', async () => {
    await handle.stop();
    handle = await serve({ hippoRoot: root, port: 0, webhookBodyDeadlineMs: 50 });
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'test-only-webhook-signing-material');
    for (const malformed of ['sha256=00', 'sha1=' + '0'.repeat(40), `sha256=${'g'.repeat(64)}`]) {
      expect(await statusUntilServerCloses(handle.port, '/v1/connectors/github/events', `X-Hub-Signature-256: ${malformed}\r\n`)).toBe('HTTP/1.1 401 Unauthorized');
    }
  });
});
