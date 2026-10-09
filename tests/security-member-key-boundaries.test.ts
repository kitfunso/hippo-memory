/**
 * Member-key privilege boundaries.
 *
 * Three escalations a member API key used to have inside its own tenant:
 *   1. mint API keys (including an ADMIN key) and revoke other keys (1.45.0
 *      closed this too; members may still list keys and revoke their own);
 *   2. read any private (`<source>:private:*`) or quarantined scope by naming
 *      it on recall or assemble;
 *   3. act as admin through POST /mcp, whose tools built an admin actor for
 *      every caller.
 * Admins (tenant owners, the local CLI, loopback without a key) keep full
 * access. Real HTTP server on port 0, real SQLite, no mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey, listApiKeys } from '../src/store/auth.js';
import { Layer } from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { serve, type ServerHandle } from '../src/server.js';
import * as api from '../src/api.js';
import { makeRoot } from './_helpers/make-root.js';

const PRIVATE_SCOPE = 'slack:private:CSECRET1';
const PUBLIC_SCOPE = 'slack:public:CGENERAL';
const PRIVATE_TEXT = 'zanzibar payroll migration happens friday in the private channel';
const PUBLIC_TEXT = 'zanzibar release notes are posted in the general channel';

function mintKey(home: string, role: 'admin' | 'member'): { plaintext: string; keyId: string } {
  const db = openHippoDb(home);
  try {
    return createApiKey(db, { tenantId: 'default', label: `${role}-test`, role });
  } finally {
    closeHippoDb(db);
  }
}

function keyCount(home: string): number {
  const db = openHippoDb(home);
  try {
    return listApiKeys(db, { active: true }).length;
  } finally {
    closeHippoDb(db);
  }
}

function seedScopedMemories(home: string): void {
  writeEntry(home, { ...createMemory(PRIVATE_TEXT, { layer: Layer.Episodic }), scope: PRIVATE_SCOPE });
  writeEntry(home, { ...createMemory(PUBLIC_TEXT, { layer: Layer.Episodic }), scope: PUBLIC_SCOPE });
}

describe('member-key boundaries over HTTP', () => {
  let home: string;
  let globalHome: string;
  let origHippoHome: string | undefined;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot('member-bounds');
    globalHome = makeRoot('member-bounds');
    origHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
    seedScopedMemories(home);
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    if (origHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = origHippoHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  function get(path: string, key: string): Promise<Response> {
    return fetch(`${handle.url}${path}`, { headers: { authorization: `Bearer ${key}` } });
  }

  it('a member key cannot mint a key or revoke another key', async () => {
    const member = mintKey(home, 'member');
    const admin = mintKey(home, 'admin');
    const before = keyCount(home);

    for (const role of ['admin', 'member']) {
      const res = await fetch(`${handle.url}/v1/auth/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${member.plaintext}` },
        body: JSON.stringify({ label: 'escalate', role }),
      });
      expect(res.status).toBe(403);
    }
    expect(keyCount(home)).toBe(before);

    const revoke = await fetch(`${handle.url}/v1/auth/keys/${admin.keyId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${member.plaintext}` },
    });
    expect(revoke.status).toBe(403);
    expect(keyCount(home)).toBe(before);
  });

  it('an admin key still manages keys', async () => {
    const admin = mintKey(home, 'admin');
    const res = await fetch(`${handle.url}/v1/auth/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.plaintext}` },
      body: JSON.stringify({ label: 'svc', role: 'member' }),
    });
    expect(res.status).toBe(200);
    expect((await get('/v1/auth/keys', admin.plaintext)).status).toBe(200);
  });

  it('a member key cannot unlock a private or quarantined scope by naming it', async () => {
    const member = mintKey(home, 'member');
    for (const scope of [PRIVATE_SCOPE, 'unknown:legacy']) {
      const res = await get(`/v1/memories?q=zanzibar&scope=${encodeURIComponent(scope)}`, member.plaintext);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('payroll');
    }
    const assemble = await get(`/v1/sessions/sess_1/assemble?scope=${encodeURIComponent(PRIVATE_SCOPE)}`, member.plaintext);
    expect(assemble.status).toBe(403);
  });

  it('a member key still recalls public scopes and default results, never the private row', async () => {
    const member = mintKey(home, 'member');
    const scoped = await get(`/v1/memories?q=zanzibar&scope=${encodeURIComponent(PUBLIC_SCOPE)}`, member.plaintext);
    expect(scoped.status).toBe(200);
    expect(await scoped.text()).toContain('release notes');

    const unscoped = await get('/v1/memories?q=zanzibar', member.plaintext);
    expect(unscoped.status).toBe(200);
    const body = await unscoped.text();
    expect(body).toContain('release notes');
    expect(body).not.toContain('payroll');
  });

  it('an admin key can still read a private scope it names', async () => {
    const admin = mintKey(home, 'admin');
    const res = await get(`/v1/memories?q=zanzibar&scope=${encodeURIComponent(PRIVATE_SCOPE)}`, admin.plaintext);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('payroll');
  });

  it('MCP over HTTP runs a member key as a member, not as admin', async () => {
    const member = mintKey(home, 'member');
    const admin = mintKey(home, 'admin');
    async function callTool(key: string, name: string, args: Record<string, string>): Promise<{ status: number; text: string }> {
      const res = await fetch(`${handle.url}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return { status: res.status, text: await res.text() };
    }

    for (const tool of ['hippo_recall', 'hippo_context']) {
      const denied = await callTool(member.plaintext, tool, { query: 'zanzibar', scope: PRIVATE_SCOPE });
      expect(denied.text).not.toContain('payroll');
      expect(denied.status === 403 || denied.text.includes('requires admin role')).toBe(true);
    }

    const allowed = await callTool(admin.plaintext, 'hippo_recall', { query: 'zanzibar', scope: PRIVATE_SCOPE });
    expect(allowed.status).toBe(200);
    expect(allowed.text).toContain('payroll');
  });
});

describe('member-key boundaries in the api layer (every surface goes through it)', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot('member-bounds');
    seedScopedMemories(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const memberCtx = (): api.Context => ({ hippoRoot: home, tenantId: 'default', actor: { subject: 'api_key:m', role: 'member' } });
  const adminCtx = (): api.HippoDbContext => ({ hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } });

  it('key management refuses a member actor', () => {
    expect(() => api.authCreate(memberCtx(), { role: 'admin' })).toThrow(api.ForbiddenError);
    expect(() => api.authRevoke(memberCtx(), 'k_missing')).toThrow(api.ForbiddenError);
    expect(api.authCreate(adminCtx(), { role: 'member' }).role).toBe('member');
  });

  it('recall and assemble refuse a restricted scope for a member, and allow it for an admin', async () => {
    expect(() => api.recall(memberCtx(), { query: 'zanzibar', scope: PRIVATE_SCOPE })).toThrow(api.ScopeForbiddenError);
    expect(() => api.recall(memberCtx(), { query: 'zanzibar', scope: 'unknown:legacy' })).toThrow(api.ScopeForbiddenError);
    await expect(api.assemble(memberCtx(), 'sess_1', { scope: PRIVATE_SCOPE })).rejects.toThrow(api.ScopeForbiddenError);

    expect(api.recall(memberCtx(), { query: 'zanzibar', scope: PUBLIC_SCOPE }).results.length).toBeGreaterThan(0);
    const adminResults = api.recall(adminCtx(), { query: 'zanzibar', scope: PRIVATE_SCOPE }).results;
    expect(adminResults.map((r) => r.content).join(' ')).toContain('payroll');
  });
});
