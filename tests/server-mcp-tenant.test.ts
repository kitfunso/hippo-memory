import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { serve, type ServerHandle } from '../src/server.js';

// Regression: MCP-over-HTTP must thread the auth-resolved tenant into the
// MCP dispatcher. Before the fix, executeTool resolved tenantId from
// HIPPO_TENANT (env), so a Bearer for tenant 'alpha' silently dropped to
// whatever the env said — defaulting to 'default' when HIPPO_TENANT was
// unset. Hippo root suffered the same bug via findHippoRoot() walking
// from cwd. This test pins both: the per-test root is used (no env hacks)
// AND the resulting memory carries tenant_id='alpha'.

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-mcp-tenant-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

describe('MCP-over-HTTP tenant context', () => {
  let home: string;
  let handle: ServerHandle;
  let prevTenant: string | undefined;

  beforeEach(async () => {
    home = makeRoot();
    // Explicitly clear HIPPO_TENANT so any leak from executeTool's old
    // resolveTenantId({}) path would surface as 'default' rather than
    // accidentally matching 'alpha'.
    prevTenant = process.env.HIPPO_TENANT;
    delete process.env.HIPPO_TENANT;
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    if (prevTenant === undefined) delete process.env.HIPPO_TENANT;
    else process.env.HIPPO_TENANT = prevTenant;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  it('Bearer token for tenant alpha lands the memory under tenant_id=alpha', async () => {
    // Mint an API key bound to tenant 'alpha' directly via the auth helper —
    // the same path the /v1/auth/keys POST exercises end-to-end.
    const db = openHippoDb(home);
    let plaintext: string;
    try {
      const minted = createApiKey(db, { tenantId: 'alpha', label: 'mcp-test' });
      plaintext = minted.plaintext;
    } finally {
      closeHippoDb(db);
    }

    const sentinel = `mcp-tenant-canary-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const res = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${plaintext}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'hippo_remember',
          arguments: { text: sentinel },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { result?: { content: Array<{ text: string }> } };
    const replyText = body.result?.content?.[0]?.text ?? '';
    expect(replyText).toMatch(/Remembered/i);

    // Inspect the row directly: tenant_id MUST be 'alpha'. The bug we are
    // guarding against would have written 'default' here.
    const verify = openHippoDb(home);
    try {
      const rows = verify
        .prepare(`SELECT tenant_id, content FROM memories WHERE content = ?`)
        .all(sentinel) as Array<{ tenant_id: string; content: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.tenant_id).toBe('alpha');
    } finally {
      closeHippoDb(verify);
    }
  });
});
