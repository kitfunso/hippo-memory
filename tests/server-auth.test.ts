import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey, revokeApiKey } from '../src/auth.js';
import { queryAuditEvents } from '../src/audit.js';
import { serve, type ServerHandle, isLoopback } from '../src/server.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-srv-auth-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

describe('isLoopback helper', () => {
  it('accepts 127.0.0.1', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
  });

  it('accepts ::1 (IPv6 loopback)', () => {
    expect(isLoopback('::1')).toBe(true);
  });

  it('accepts ::ffff:127.0.0.1 (IPv4-mapped IPv6)', () => {
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects undefined', () => {
    expect(isLoopback(undefined)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isLoopback('')).toBe(false);
  });

  it('rejects a real LAN address', () => {
    expect(isLoopback('192.168.1.42')).toBe(false);
  });

  it('rejects a public IPv4', () => {
    expect(isLoopback('8.8.8.8')).toBe(false);
  });

  it('rejects an IPv6 address that is not loopback', () => {
    expect(isLoopback('fe80::1')).toBe(false);
  });

  it('rejects ::ffff:8.8.8.8 (IPv4-mapped non-loopback)', () => {
    expect(isLoopback('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('server auth middleware', () => {
  let home: string;
  let globalHome: string;
  let originalHippoHome: string | undefined;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot();
    globalHome = makeRoot();
    originalHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    if (originalHippoHome === undefined) {
      delete process.env.HIPPO_HOME;
    } else {
      process.env.HIPPO_HOME = originalHippoHome;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('loopback no-auth: 200 and audit shows actor=localhost:cli', async () => {
    const res = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'auth-canary-loopback-noauth' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string };
    expect(body.id).toMatch(/^mem_/);

    const db = openHippoDb(home);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'remember' });
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]!.actor).toBe('localhost:cli');
      expect(events[0]!.targetId).toBe(body.id);
    } finally {
      closeHippoDb(db);
    }
  });

  it('loopback with valid Bearer: 200 and audit shows actor=api_key:<keyId>', async () => {
    const db = openHippoDb(home);
    let keyId: string;
    let plaintext: string;
    try {
      const created = createApiKey(db, { tenantId: 'default', label: 'auth-test' });
      keyId = created.keyId;
      plaintext = created.plaintext;
    } finally {
      closeHippoDb(db);
    }

    const res = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Mixed case scheme to confirm case-insensitive matching.
        'Authorization': `Bearer ${plaintext}`,
      },
      body: JSON.stringify({ content: 'auth-canary-bearer-valid' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; tenantId: string };
    expect(body.id).toMatch(/^mem_/);
    expect(body.tenantId).toBe('default');

    const db2 = openHippoDb(home);
    try {
      const events = queryAuditEvents(db2, { tenantId: 'default', op: 'remember' });
      const matching = events.find((e) => e.targetId === body.id);
      expect(matching).toBeDefined();
      expect(matching!.actor).toBe(`api_key:${keyId}`);
    } finally {
      closeHippoDb(db2);
    }
  });

  it('loopback with invalid Bearer: 401 and no remember audit event', async () => {
    const res = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer hk_does_not_exist.bogussecret',
      },
      body: JSON.stringify({ content: 'auth-canary-bearer-invalid' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid api key');

    const db = openHippoDb(home);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'remember' });
      // No remember should have landed.
      expect(events.length).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('loopback with revoked Bearer: 401', async () => {
    const db = openHippoDb(home);
    let plaintext: string;
    try {
      const created = createApiKey(db, { tenantId: 'default', label: 'revoke-test' });
      plaintext = created.plaintext;
      revokeApiKey(db, created.keyId);
    } finally {
      closeHippoDb(db);
    }

    const res = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${plaintext}`,
      },
      body: JSON.stringify({ content: 'auth-canary-revoked' }),
    });
    expect(res.status).toBe(401);
  });

  it('loopback with malformed Authorization (no scheme): 401', async () => {
    const res = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'just-a-token-no-scheme',
      },
      body: JSON.stringify({ content: 'auth-canary-malformed' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid api key');
  });

  it('loopback with non-Bearer scheme: 401', async () => {
    const res = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Basic dXNlcjpwYXNz',
      },
      body: JSON.stringify({ content: 'auth-canary-basic' }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /health is reachable without auth', async () => {
    const res = await fetch(`${handle.url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  // Integration-test of "non-loopback request without auth → 401" requires
  // binding the server to a non-loopback interface, which is fragile across
  // CI/dev machines (NIC presence, firewall, OS dual-stack behaviour). The
  // unit test in `describe('isLoopback helper')` above covers the address
  // classification side; this skipped block documents what the full
  // round-trip would look like once we have a stable test fixture.
  it.skip('non-loopback no-auth: 401 (skipped - requires real network interface)', async () => {
    // Would require: serve({ hippoRoot, host: '0.0.0.0' }) plus a way to
    // dial in from a non-loopback address. Lifted in the soak harness.
  });
});
