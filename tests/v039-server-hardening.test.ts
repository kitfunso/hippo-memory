import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, scryptSync, randomBytes } from 'node:crypto';
import { initStore } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey, revokeApiKey, validateApiKey } from '../src/auth.js';
import { remember as apiRemember } from '../src/api.js';
import { handleMcpRequest } from '../src/mcp/server.js';

// v0.39 commit 5 — Server hardening regressions:
//   - Fix 5.2: DUMMY_HASH precomputed at module load; miss path runs verifyKey
//     so the timing signal between hit and miss is reduced.
//   - Fix 5.3: /mcp/stream heartbeat re-validates bearer; MCP_SSE_MAX_AGE_SEC
//     caps stream age. MCP_SSE_HEARTBEAT_MS makes the interval testable.
//   - Fix 5.4: graceful shutdown awaits server.stop() before process.exit.
//     Tested by directly exercising stop() while a request is in flight; we
//     do NOT raise SIGTERM because vitest skips signal handlers (VITEST=1)
//     and a real signal would also kill the test runner.
//   - Fix 5.5: PUBLIC_ROUTES bypass attempts (trailing slash, encoded slash,
//     wrong method, query string).
//   - Fix 5.6: default-deny lower-level loader — MCP recall with no scope
//     hides slack:private:* memories.

const SLACK_SECRET = 'shhh-v039-hardening';

function signSlack(ts: string, body: string): string {
  return `v0=${createHmac('sha256', SLACK_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
}

describe('v039 server hardening', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-v039-server-'));
    initStore(root);
  });

  afterEach(async () => {
    if (handle) {
      try { await handle.stop(); } catch { /* already stopped */ }
    }
    delete process.env.HIPPO_REQUIRE_AUTH;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.MCP_SSE_MAX_AGE_SEC;
    delete process.env.MCP_SSE_HEARTBEAT_MS;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  // ---- Fix 5.2: auth timing reduced -------------------------------------
  //
  // We measure wall-clock elapsed time of validateApiKey on:
  //   - hit: a real key in the DB
  //   - miss-known-format: an unknown key with the dotted shape
  // Both should run scrypt exactly once now. We assert the miss path is
  // within 50% of the hit path (loose bound — CI is noisy and scrypt is
  // sensitive to background load). The key behavioral assertion is "miss
  // path ran scrypt at all" — pre-fix it returned ~instantly.
  it('auth timing: miss path pays scrypt cost (within 50% of hit)', () => {
    const db = openHippoDb(root);
    let plaintext: string;
    try {
      const created = createApiKey(db, { tenantId: 'default', label: 'timing-hit' });
      plaintext = created.plaintext;

      // Warmup — JIT, scrypt cost cache, etc.
      for (let i = 0; i < 3; i++) {
        validateApiKey(db, plaintext);
        validateApiKey(db, 'hk_unknown_key.unknown_secret_blob');
      }

      // Sample multiple iterations; take the median to dampen GC noise.
      const N = 7;
      const hitTimes: number[] = [];
      const missTimes: number[] = [];
      for (let i = 0; i < N; i++) {
        const t0 = process.hrtime.bigint();
        validateApiKey(db, plaintext);
        const t1 = process.hrtime.bigint();
        hitTimes.push(Number(t1 - t0));

        const t2 = process.hrtime.bigint();
        validateApiKey(db, 'hk_unknown_key.unknown_secret_blob');
        const t3 = process.hrtime.bigint();
        missTimes.push(Number(t3 - t2));
      }
      hitTimes.sort((a, b) => a - b);
      missTimes.sort((a, b) => a - b);
      const hit = hitTimes[Math.floor(N / 2)]!;
      const miss = missTimes[Math.floor(N / 2)]!;
      // Both branches now run scrypt once. Hard floor: miss must be at
      // least 30% of hit (proves scrypt ran). Hard ceiling: miss within
      // +50% of hit (loose for CI; tight enough to catch a regression
      // where the miss path skipped verifyKey entirely).
      expect(miss).toBeGreaterThan(hit * 0.3);
      expect(miss).toBeLessThan(hit * 1.5);
    } finally {
      closeHippoDb(db);
    }
  });

  // ---- Fix 5.2: malformed key (no dot) still pays scrypt cost ----------
  it('auth timing: malformed input (no dot) pays scrypt cost', () => {
    const db = openHippoDb(root);
    try {
      // Warmup
      for (let i = 0; i < 3; i++) validateApiKey(db, 'no-dot-here');

      const t0 = process.hrtime.bigint();
      const result = validateApiKey(db, 'no-dot-here');
      const t1 = process.hrtime.bigint();
      const elapsed = Number(t1 - t0);
      expect(result.valid).toBe(false);
      // scrypt of 32-byte keylen costs ~30ms on dev hardware. We assert at
      // least 5ms to stay safe under heavily-loaded CI; the pre-fix path
      // returned in <0.1ms.
      expect(elapsed).toBeGreaterThan(5_000_000);
    } finally {
      closeHippoDb(db);
    }
  });

  // ---- Fix 5.3: SSE max-age closes stream ------------------------------
  it('SSE max-age closes stream with reason=max_age_exceeded', async () => {
    process.env.MCP_SSE_MAX_AGE_SEC = '1';
    process.env.MCP_SSE_HEARTBEAT_MS = '200'; // poll fast
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });

    const ac = new AbortController();
    try {
      const res = await fetch(`${handle.url}/mcp/stream`, {
        headers: { accept: 'text/event-stream' },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // Drain frames for up to 3s, looking for "event: closed" with
      // reason=max_age_exceeded.
      let buf = '';
      let closedReason: string | null = null;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && closedReason === null) {
        const r = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: true }), 500),
          ),
        ]);
        if (r.value) buf += decoder.decode(r.value);
        const m = buf.match(/event:\s*closed\s*\ndata:\s*(\{[^\n]*\})/);
        if (m) {
          const parsed = JSON.parse(m[1]!) as { reason?: string };
          closedReason = parsed.reason ?? null;
          break;
        }
        if (r.done) break;
      }
      try { reader.cancel().catch(() => {}); } catch { /* no-op */ }
      expect(closedReason).toBe('max_age_exceeded');
    } finally {
      ac.abort();
    }
  }, 10_000);

  // ---- Fix 5.3: SSE auth-revoked closes stream -------------------------
  it('SSE heartbeat closes stream with reason=auth_revoked when key revoked', async () => {
    process.env.HIPPO_REQUIRE_AUTH = '1';
    process.env.MCP_SSE_HEARTBEAT_MS = '200';
    process.env.MCP_SSE_MAX_AGE_SEC = '60'; // far enough out of the way
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });

    // Mint a key, open stream with it, then revoke and wait for the
    // heartbeat to detect.
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
      const decoder = new TextDecoder();

      // Read initial ping to confirm stream live.
      const first = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 1000),
        ),
      ]);
      expect(first.done).toBe(false);

      // Now revoke the key. Next heartbeat should close the stream.
      const db2 = openHippoDb(root);
      try { revokeApiKey(db2, keyId); } finally { closeHippoDb(db2); }

      let buf = decoder.decode(first.value);
      let closedReason: string | null = null;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && closedReason === null) {
        const r = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: true }), 500),
          ),
        ]);
        if (r.value) buf += decoder.decode(r.value);
        const m = buf.match(/event:\s*closed\s*\ndata:\s*(\{[^\n]*\})/);
        if (m) {
          const parsed = JSON.parse(m[1]!) as { reason?: string };
          closedReason = parsed.reason ?? null;
          break;
        }
        if (r.done) break;
      }
      try { reader.cancel().catch(() => {}); } catch { /* no-op */ }
      expect(closedReason).toBe('auth_revoked');
    } finally {
      ac.abort();
    }
  }, 10_000);

  // ---- Fix 5.4: graceful shutdown awaits stop() ------------------------
  //
  // We exercise the async stop() path directly (vitest skips signal
  // handlers, so a real SIGTERM here would kill the runner). The contract
  // we care about: stop() resolves only after server.close() resolves,
  // which can only happen after in-flight requests finish.
  //
  // Strategy: open a long-lived SSE stream, then call stop(). Pre-fix,
  // stop() either hung (SSE keepalive blocks server.close) or returned
  // before the connection was force-closed. Post-fix, stop() calls
  // closeAllConnections() and resolves cleanly.
  it('graceful shutdown: stop() resolves while SSE stream is open', async () => {
    process.env.MCP_SSE_HEARTBEAT_MS = '60000'; // keep stream sleepy
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });

    const ac = new AbortController();
    const streamPromise = fetch(`${handle.url}/mcp/stream`, {
      headers: { accept: 'text/event-stream' },
      signal: ac.signal,
    }).catch(() => null);

    const res = await streamPromise;
    expect(res?.status).toBe(200);

    const stopStarted = Date.now();
    await handle.stop();
    const stopElapsed = Date.now() - stopStarted;
    // stop() must resolve within a few seconds — pre-fix this hung
    // until the SSE keepalive timer fired (30s).
    expect(stopElapsed).toBeLessThan(5000);
    // Re-running stop is safe (idempotent).
    await handle.stop();
    ac.abort();
    // Mark handle stopped so afterEach doesn't double-stop.
    (handle as { stop: () => Promise<void> }).stop = async () => {};
  }, 10_000);

  // ---- Fix 5.5: PUBLIC_ROUTES bypass attempts --------------------------
  describe('PUBLIC_ROUTES bypass attempts', () => {
    beforeEach(async () => {
      process.env.SLACK_SIGNING_SECRET = SLACK_SECRET;
      process.env.HIPPO_REQUIRE_AUTH = '1';
      handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
    });

    it('trailing slash on slack events does NOT bypass auth (still HMAC-required)', async () => {
      const body = JSON.stringify({ type: 'url_verification', challenge: 'x' });
      // Trailing slash → path !== exact match in PUBLIC_ROUTES, so route
      // falls through. With HIPPO_REQUIRE_AUTH=1, the bearer check fires
      // and returns 401. Critically: NOT 200.
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(res.status).not.toBe(200);
      // 401 (auth required) or 404 (no such route) both prove no bypass.
      expect([401, 404]).toContain(res.status);
    });

    it('encoded slash variant does not bypass', async () => {
      // %2F encoded slash creates a different path that does not match
      // the public route. Must NOT 200 without bearer. v1.6.4 added a
      // top-of-handler reject for any %2F in the URL, so this now also
      // returns 400 — same security outcome, more specific error code.
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack%2Fevents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).not.toBe(200);
      expect([400, 401, 404]).toContain(res.status);
    });

    it('wrong method (GET) on slack events route requires auth', async () => {
      // Only POST is in PUBLIC_ROUTES. GET should 401 without bearer.
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
        method: 'GET',
      });
      expect(res.status).not.toBe(200);
      expect([401, 404, 405]).toContain(res.status);
    });

    it('query string on public route does not change routing (still HMAC-verified)', async () => {
      // Adding ?bypass=1 must not affect routing — pathname is matched,
      // search is ignored. A request without a valid signature still 401s.
      const res = await fetch(
        `http://127.0.0.1:${handle.port}/v1/connectors/slack/events?bypass=1`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      );
      // No x-slack-signature header → HMAC verify fails → 401.
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

  // ---- Fix 5.6: default-deny lower-level loader test -------------------
  it('MCP recall with no scope hides slack:private:* memories (default-deny)', async () => {
    // Seed a private slack memory + a regular memory under the same tenant.
    apiRemember(
      { hippoRoot: root, tenantId: 'default', actor: 'cli' },
      {
        content: 'private-slack-canary should not surface in default recall',
        scope: 'slack:private:CSECRET',
      },
    );
    apiRemember(
      { hippoRoot: root, tenantId: 'default', actor: 'cli' },
      { content: 'public-canary should surface in default recall' },
    );

    // Call MCP recall with no scope.
    const ctx = { hippoRoot: root, tenantId: 'default', actor: 'mcp', clientKey: 'http:t:test' };
    const res = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'hippo_recall', arguments: { query: 'canary', budget: 1500 } },
      },
      ctx,
    );
    const text = ((res as { result?: { content?: Array<{ text?: string }> } } | null)
      ?.result?.content?.[0]?.text) ?? '';
    expect(text).toContain('public-canary');
    expect(text).not.toContain('private-slack-canary');
  });
});
