import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { ServerHandle } from '../../src/server.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createApiKey, revokeApiKey } from '../../src/store/sqlite/keys/auth.js';
import { log } from '../../src/base/util/log.js';
import { makeRoot } from '../_helpers/make-root.js';
import { needsHippoDb } from '../_helpers/store-switch.js';
import { serveKeyed } from '../_helpers/keyed-server.js';
import { CONNECTOR_GROUPS } from '../../src/surface/connectors/ingest.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const SLACK_SECRET = 'shhh-v039-hardening';

function signSlack(ts: string, body: string): string {
  return `v0=${createHmac('sha256', SLACK_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
}

async function closedReasonOf(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  seen: string,
  after: string[] = [],
): Promise<string | null> {
  const decoder = new TextDecoder();
  let buf = seen;
  for (;;) {
    const m = buf.match(/event:\s*closed\s*\ndata:\s*(\{[^\n]*\})/);
    if (m) {
      // SAFETY: the matched frame's data is the JSON object the stream-close handler writes, with a `reason` field.
      return (JSON.parse(m[1]!) as { reason?: string }).reason ?? null;
    }
    const r = await reader.read();
    if (r.done) return null;
    const text = decoder.decode(r.value);
    after.push(text);
    buf += text;
  }
}

describe('server hardening', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = makeRoot('v039-server');
  });

  afterEach(async () => {
    if (handle) {
      try {
        await handle.stop();
      } catch {
        /* already stopped */
      }
    }
    vi.stubEnv('SLACK_SIGNING_SECRET', undefined);
    vi.stubEnv('MCP_SSE_MAX_AGE_SEC', undefined);
    vi.stubEnv('MCP_SSE_HEARTBEAT_MS', undefined);
  });

  it('SSE max-age closes stream with reason=max_age_exceeded', async () => {
    vi.stubEnv('MCP_SSE_MAX_AGE_SEC', '1');
    vi.stubEnv('MCP_SSE_HEARTBEAT_MS', '200');
    handle = await serveKeyed({ hippoRoot: root, host: '127.0.0.1', port: 0 });

    const ac = new AbortController();
    try {
      const res = await fetch(`${handle.url}/mcp/stream`, {
        headers: { accept: 'text/event-stream' },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const closedReason = await closedReasonOf(reader, '');
      try {
        reader.cancel().catch(() => {});
      } catch {
        /* no-op */
      }
      expect(closedReason).toBe('max_age_exceeded');
    } finally {
      ac.abort();
    }
  });

  it.skipIf(needsHippoDb('db'))('SSE heartbeat closes stream with reason=auth_revoked when key revoked', async () => {
    vi.stubEnv('MCP_SSE_HEARTBEAT_MS', '200');
    vi.stubEnv('MCP_SSE_MAX_AGE_SEC', '60');
    handle = await serveKeyed({ hippoRoot: root, host: '127.0.0.1', port: 0 });

    const db = openHippoDb(root);
    let keyId: string;
    let plaintext: string;
    try {
      const created = createApiKey(db, { tenantId: 'default', label: 'sse-revoke' });
      keyId = created.keyId;
      plaintext = created.plaintext;
    } finally {
      closeHippoDb(db);
    }

    const ac = new AbortController();
    try {
      const res = await fetch(`${handle.url}/mcp/stream`, {
        headers: { accept: 'text/event-stream', authorization: `Bearer ${plaintext}` },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();

      const first = await reader.read();
      expect(first.done).toBe(false);

      const db2 = openHippoDb(root);
      try {
        revokeApiKey(db2, keyId);
      } finally {
        closeHippoDb(db2);
      }

      const afterRevoke: string[] = [];
      const closedReason = await closedReasonOf(reader, new TextDecoder().decode(first.value), afterRevoke);
      try {
        reader.cancel().catch(() => {});
      } catch {
        /* no-op */
      }
      expect(closedReason).toBe('auth_revoked');
      expect(afterRevoke.join('')).not.toContain(': ping');
    } finally {
      ac.abort();
    }
  });

  it('graceful shutdown: stop() resolves while SSE stream is open', async () => {
    vi.stubEnv('MCP_SSE_HEARTBEAT_MS', '60000');
    handle = await serveKeyed({ hippoRoot: root, host: '127.0.0.1', port: 0 });

    const ac = new AbortController();
    const streamPromise = fetch(`${handle.url}/mcp/stream`, {
      headers: { accept: 'text/event-stream' },
      signal: ac.signal,
    }).catch(() => null);

    const res = await streamPromise;
    expect(res?.status).toBe(200);

    const warn = vi.spyOn(log, 'warn');
    await handle.stop();
    expect(warn.mock.calls.filter(([line]) => String(line).startsWith('shutdown:'))).toEqual([]);
    warn.mockRestore();
    await handle.stop();
    ac.abort();
    handle.stop = async () => {};
  });

  describe('PUBLIC_ROUTES bypass attempts', () => {
    beforeEach(async () => {
      vi.stubEnv('SLACK_SIGNING_SECRET', SLACK_SECRET);
      handle = await serveKeyed({ hippoRoot: root, host: '127.0.0.1', port: 0, keep: CONNECTOR_GROUPS });
    });

    it('trailing slash on slack events does NOT bypass auth (still HMAC-required)', async () => {
      const body = JSON.stringify({ type: 'url_verification', challenge: 'x' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(res.status).not.toBe(200);
      expect([401, 404]).toContain(res.status);
    });

    it('wrong method (GET) on slack events route requires auth', async () => {
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
        method: 'GET',
      });
      expect(res.status).not.toBe(200);
      expect([401, 404, 405]).toContain(res.status);
    });

    it('query string on public route does not change routing (still HMAC-verified)', async () => {
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events?bypass=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });

    it('valid POST with HMAC still works (positive control)', async () => {
      const body = JSON.stringify({ type: 'url_verification', challenge: 'positive' });
      const ts = String(Math.floor(Date.now() / 1000));
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': ts,
          'x-slack-signature': signSlack(ts, body),
        },
        body,
      });
      expect(res.status).toBe(200);
    });
  });
});
