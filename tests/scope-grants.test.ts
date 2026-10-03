/** Scope grants (ROADMAP Part VIII EI2): a member key reads a restricted scope
 *  only after an explicit grant. Real HTTP server, real SQLite, no mocks. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, readEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey, listScopeGrants } from '../src/auth.js';
import { createMemory, Layer } from '../src/memory.js';
import { serve, type ServerHandle } from '../src/server.js';
import { refreshBrief } from '../src/project-briefs.js';
import { extractGraph } from '../src/graph-extract.js';
import * as api from '../src/api.js';
import { consolidate } from '../src/consolidate.js';

const HIPPO_BIN = join(process.cwd(), 'bin', 'hippo.js');

const PRIVATE_SCOPE = 'slack:private:C1';
const OTHER_PRIVATE_SCOPE = 'slack:private:C2';
const PRIVATE_TEXT = 'kowalski payroll rollout starts thursday in the private channel';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-scope-grants-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  // Seeded memories carry no origin_project; isolation would hide them from
  // hippo_context regardless of scope grants, which is not what this suite tests.
  writeFileSync(join(home, 'config.json'), JSON.stringify({ contextProjectIsolation: false }));
  return home;
}

function mintKey(home: string, role: 'admin' | 'member', tenantId = 'default'): { plaintext: string; keyId: string } {
  const db = openHippoDb(home);
  try {
    return createApiKey(db, { tenantId, label: `${role}-test`, role });
  } finally {
    closeHippoDb(db);
  }
}

function seedPrivateMemory(home: string): void {
  writeEntry(home, { ...createMemory(PRIVATE_TEXT, { layer: Layer.Episodic }), scope: PRIVATE_SCOPE });
}

describe('scope grants over HTTP', () => {
  let home: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot();
    seedPrivateMemory(home);
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
  });

  function get(path: string, key: string): Promise<Response> {
    return fetch(`${handle.url}${path}`, { headers: { authorization: `Bearer ${key}` } });
  }

  async function callTool(key: string, name: string, args: Record<string, string>): Promise<{ status: number; text: string }> {
    const res = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return { status: res.status, text: await res.text() };
  }

  it('member without a grant is denied on every surface, admin unaffected', async () => {
    const member = mintKey(home, 'member');

    const scoped = await get(`/v1/memories?q=kowalski&scope=${encodeURIComponent(PRIVATE_SCOPE)}`, member.plaintext);
    expect(scoped.status).toBe(403);

    const unscoped = await get('/v1/memories?q=kowalski', member.plaintext);
    expect(unscoped.status).toBe(200);
    expect(await unscoped.text()).not.toContain('payroll');

    const recallDenied = await callTool(member.plaintext, 'hippo_recall', { query: 'kowalski', scope: PRIVATE_SCOPE });
    expect(recallDenied.text).not.toContain('payroll');
    expect(JSON.parse(recallDenied.text).error).toBeTruthy();
    const recallOpen = await callTool(member.plaintext, 'hippo_recall', { query: 'kowalski' });
    expect(recallOpen.text).not.toContain('payroll');

    const contextDenied = await callTool(member.plaintext, 'hippo_context', { scope: PRIVATE_SCOPE, budget: '4000' });
    expect(contextDenied.text).not.toContain('payroll');
    expect(JSON.parse(contextDenied.text).error).toBeTruthy();

    const assemble = await get(`/v1/sessions/sess_1/assemble?scope=${encodeURIComponent(PRIVATE_SCOPE)}`, member.plaintext);
    expect(assemble.status).toBe(403);
  });

  it('a grant admits the named scope over HTTP and MCP, other restricted scopes stay denied, ungrant revokes it', async () => {
    const member = mintKey(home, 'member');
    const adminCtx: api.Context = { hippoRoot: home, tenantId: 'default', actor: api.adminActor('cli') };

    api.authGrant(adminCtx, member.keyId, PRIVATE_SCOPE);

    const scoped = await get(`/v1/memories?q=kowalski&scope=${encodeURIComponent(PRIVATE_SCOPE)}`, member.plaintext);
    expect(scoped.status).toBe(200);
    expect(await scoped.text()).toContain('payroll');

    const recallAllowed = await callTool(member.plaintext, 'hippo_recall', { query: 'kowalski', scope: PRIVATE_SCOPE });
    expect(recallAllowed.text).toContain('payroll');

    // hippo_context ranks by an auto-detected git query, not args.query, so content
    // relevance is out of scope here; the grant is proven by the absence of the
    // scope-forbidden error that the denied case above asserts.
    const contextAllowed = await callTool(member.plaintext, 'hippo_context', { scope: PRIVATE_SCOPE, budget: '4000' });
    expect(JSON.parse(contextAllowed.text).error).toBeUndefined();

    // A second restricted scope, never granted, stays denied.
    const otherDenied = await get(`/v1/memories?q=kowalski&scope=${encodeURIComponent(OTHER_PRIVATE_SCOPE)}`, member.plaintext);
    expect(otherDenied.status).toBe(403);

    api.authUngrant(adminCtx, member.keyId, PRIVATE_SCOPE);
    const afterUngrant = await get(`/v1/memories?q=kowalski&scope=${encodeURIComponent(PRIVATE_SCOPE)}`, member.plaintext);
    expect(afterUngrant.status).toBe(403);
  });

  it('a member cannot name a mixed-case private scope the SQL filter hides', async () => {
    const member = mintKey(home, 'member');
    const res = await get(`/v1/memories?q=kowalski&scope=${encodeURIComponent('Slack:Private:C1')}`, member.plaintext);
    expect(res.status).toBe(403);
  });

  it('a mixed-case private row never reaches a member through default recall on HTTP or MCP', async () => {
    writeEntry(home, { ...createMemory('zzzmixedcasezzz quarterly numbers', { layer: Layer.Episodic }), scope: 'Slack:Private:C9' });
    const member = mintKey(home, 'member');
    expect(await (await get('/v1/memories?q=zzzmixedcasezzz+quarterly', member.plaintext)).text()).not.toContain('zzzmixedcasezzz');
    expect((await callTool(member.plaintext, 'hippo_recall', { query: 'zzzmixedcasezzz quarterly' })).text).not.toContain('zzzmixedcasezzz');
  });

  it('a consolidation merge of private sources never reaches a member through default recall', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ contextProjectIsolation: false, replay: { count: 0 } }));
    const backbone = 'rotate the staging tls certificates before expiry';
    writeEntry(home, createMemory(backbone, { layer: Layer.Episodic, scope: PRIVATE_SCOPE }));
    writeEntry(home, createMemory(`${backbone} zzzprivatemarkerzzz notify on-call`, { layer: Layer.Episodic, scope: PRIVATE_SCOPE }));
    const result = await consolidate(home, { dryRun: false });
    expect(result.semanticCreated).toBe(1);

    const member = mintKey(home, 'member');
    const res = await get('/v1/memories?q=staging+tls+certificates+zzzprivatemarkerzzz', member.plaintext);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('zzzprivatemarkerzzz');

    const admin = mintKey(home, 'admin');
    const adminRes = await get(`/v1/memories?q=staging+tls+certificates&scope=${encodeURIComponent(PRIVATE_SCOPE)}`, admin.plaintext);
    expect(await adminRes.text()).toContain('zzzprivatemarkerzzz');
  });
});

describe('authGrant / authUngrant validation (api layer)', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('a member actor cannot grant', () => {
    const member = mintKey(home, 'member');
    const memberCtx: api.Context = { hippoRoot: home, tenantId: 'default', actor: { subject: `api_key:${member.keyId}`, role: 'member' } };
    expect(() => api.authGrant(memberCtx, member.keyId, PRIVATE_SCOPE)).toThrow(api.ForbiddenError);
    expect(() => api.authUngrant(memberCtx, member.keyId, PRIVATE_SCOPE)).toThrow(api.ForbiddenError);
  });

  it('rejects a key belonging to another tenant', () => {
    const other = mintKey(home, 'member', 'other-tenant');
    const adminCtx: api.Context = { hippoRoot: home, tenantId: 'default', actor: api.adminActor('cli') };
    expect(() => api.authGrant(adminCtx, other.keyId, PRIVATE_SCOPE)).toThrow(/Unknown key_id/);
  });

  it('rejects a grant on a revoked key', () => {
    const member = mintKey(home, 'member');
    const adminCtx: api.Context = { hippoRoot: home, tenantId: 'default', actor: api.adminActor('cli') };
    api.authRevoke(adminCtx, member.keyId);
    expect(() => api.authGrant(adminCtx, member.keyId, PRIVATE_SCOPE)).toThrow(/revoked/);
  });

  it('CLI grant runs in the key\'s own tenant', () => {
    const other = mintKey(home, 'member', 'other-tenant');
    execFileSync('node', [HIPPO_BIN, 'auth', 'grant', other.keyId, PRIVATE_SCOPE, '--global'], {
      cwd: home, env: { ...process.env, HIPPO_HOME: home, HIPPO_TENANT: 'default' }, stdio: 'pipe',
    });
    const db = openHippoDb(home);
    try {
      expect(listScopeGrants(db, other.keyId)).toEqual([PRIVATE_SCOPE]);
    } finally {
      closeHippoDb(db);
    }
  });

  it('rejects an unrestricted scope', () => {
    const member = mintKey(home, 'member');
    const adminCtx: api.Context = { hippoRoot: home, tenantId: 'default', actor: api.adminActor('cli') };
    expect(() => api.authGrant(adminCtx, member.keyId, 'slack:public:general')).toThrow();
  });

  it('writes auth_grant / auth_ungrant audit rows', () => {
    const member = mintKey(home, 'member');
    const adminCtx: api.Context = { hippoRoot: home, tenantId: 'default', actor: api.adminActor('cli') };
    api.authGrant(adminCtx, member.keyId, PRIVATE_SCOPE);
    api.authUngrant(adminCtx, member.keyId, PRIVATE_SCOPE);

    const grants = api.auditList(adminCtx, { op: 'auth_grant' });
    expect(grants.some((e) => e.targetId === member.keyId)).toBe(true);
    const ungrants = api.auditList(adminCtx, { op: 'auth_ungrant' });
    expect(ungrants.some((e) => e.targetId === member.keyId)).toBe(true);
  });

  it('grantScope is idempotent and listScopeGrants reflects it', () => {
    const member = mintKey(home, 'member');
    const adminCtx: api.Context = { hippoRoot: home, tenantId: 'default', actor: api.adminActor('cli') };
    api.authGrant(adminCtx, member.keyId, PRIVATE_SCOPE);
    api.authGrant(adminCtx, member.keyId, PRIVATE_SCOPE);
    const db = openHippoDb(home);
    try {
      expect(listScopeGrants(db, member.keyId)).toEqual([PRIVATE_SCOPE]);
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('supersede keeps the old row\'s scope', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('api.supersede: the successor of a private row stays in that scope', () => {
    const old = createMemory(PRIVATE_TEXT, { layer: Layer.Episodic, scope: PRIVATE_SCOPE });
    writeEntry(home, old);
    const ctx: api.Context = { hippoRoot: home, tenantId: 'default', actor: api.adminActor('cli') };
    const result = api.supersede(ctx, old.id, 'kowalski payroll rollout moved to friday');
    const successor = readEntry(home, result.newId, 'default');
    expect(successor?.scope).toBe(PRIVATE_SCOPE);
  });

  it('CLI supersede: the successor of a private row stays in that scope', () => {
    const cliHome = mkdtempSync(join(tmpdir(), 'hippo-scope-grants-cli-'));
    try {
      const env = { HIPPO_HOME: join(cliHome, 'global-hippo'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
      execFileSync('node', [HIPPO_BIN, 'init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd: cliHome, env: { ...process.env, ...env } });
      const hippoDir = join(cliHome, '.hippo');
      const old = createMemory(PRIVATE_TEXT, { layer: Layer.Episodic, scope: PRIVATE_SCOPE, tenantId: 'default' });
      writeEntry(hippoDir, old);

      execFileSync('node', [HIPPO_BIN, 'supersede', old.id, 'kowalski payroll rollout moved to friday'], {
        cwd: cliHome, env: { ...process.env, ...env },
      });

      const refreshed = readEntry(hippoDir, old.id, 'default');
      const successor = refreshed?.superseded_by ? readEntry(hippoDir, refreshed.superseded_by, 'default') : null;
      expect(successor?.scope).toBe(PRIVATE_SCOPE);
    } finally {
      rmSync(cliHome, { recursive: true, force: true });
    }
  });
});

describe('graph view carries no private receipt text (T4 withdrawn, T6 closes the transitive path)', () => {
  let home: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot();
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it('GET /v1/graph as a member never contains private receipt text after a brief refresh + graph extract', async () => {
    const member = mintKey(home, 'member');
    writeEntry(home, { ...createMemory(PRIVATE_TEXT, { layer: Layer.Episodic, tags: ['path:testrepo'], source: 'test' }), scope: PRIVATE_SCOPE });
    writeEntry(home, { ...createMemory('testrepo release notes went out today', { layer: Layer.Episodic, tags: ['path:testrepo'], source: 'test' }), scope: null });

    refreshBrief(home, 'default', 'testrepo');
    extractGraph(home, 'default');

    const res = await fetch(`${handle.url}/v1/graph`, { headers: { authorization: `Bearer ${member.plaintext}` } });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('payroll');
  });
});
