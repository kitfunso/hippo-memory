// Cross-tenant actions need a host admin: a tenant's own admin key stops at its tenant. Real server, real SQLite.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { adminActor } from '../src/api.js';
import { serve, type ServerHandle } from '../src/server.js';
import { handleMcpRequest, type McpResponse } from '../src/mcp/server.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

let home: string;
let globalHome: string;
let handle: ServerHandle;

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.hippo'), { recursive: true });
  initStore(dir);
  return dir;
}

function key(tenantId: string, role: 'admin' | 'member'): string {
  const db = openHippoDb(home);
  try {
    return createApiKey(db, { tenantId, label: `${tenantId}-${role}`, role }).plaintext;
  } finally {
    closeHippoDb(db);
  }
}

function headers(bearer?: string) {
  const json = { 'content-type': 'application/json' };
  return bearer ? { ...json, authorization: `Bearer ${bearer}` } : json;
}

const audit = (qs: string, bearer?: string) => fetch(`${handle.url}/v1/audit${qs}`, { headers: headers(bearer) });
const sleep = (bearer?: string) =>
  fetch(`${handle.url}/v1/sleep`, { method: 'POST', headers: headers(bearer), body: JSON.stringify({ dry_run: true }) });

async function mcpCall(name: string, args: Record<string, string | number>, bearer: string): Promise<McpResponse> {
  const res = await fetch(`${handle.url}/mcp`, {
    method: 'POST',
    headers: headers(bearer),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  // SAFETY: POST /mcp always answers a tools/call with a JSON-RPC envelope.
  return await res.json() as McpResponse;
}

function sleepRuns(): number {
  const db = openHippoDb(home);
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM consolidation_runs').get<{ n: number }>().n;
  } finally {
    closeHippoDb(db);
  }
}

beforeEach(async () => {
  home = makeRoot('hippo-host-admin-');
  globalHome = makeRoot('hippo-host-admin-global-');
  vi.stubEnv('HIPPO_HOME', globalHome);
  vi.stubEnv('HIPPO_TENANT', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(globalHome, { recursive: true, force: true });
});

describe('tenant admin stops at its own tenant', () => {
  it('refuses a tenant admin another tenant audit log', async () => {
    const res = await audit('?tenant=default', key('acme', 'admin'));
    expect(res.status).toBe(403);
    // SAFETY: HttpError responses are always JSON shaped { error: string }.
    expect((await res.json() as { error: string }).error).toContain('host admin');
  });

  it('refuses a tenant admin host-wide sleep', async () => {
    const res = await sleep(key('acme', 'admin'));
    expect(res.status).toBe(403);
    // SAFETY: HttpError responses are always JSON shaped { error: string }.
    expect((await res.json() as { error: string }).error).toContain('host admin');
  });

  it('still serves a tenant admin its own audit log', async () => {
    const k = key('acme', 'admin');
    expect((await audit('', k)).status).toBe(200);
    expect((await audit('?tenant=acme', k)).status).toBe(200);
  });
});

describe('host admin is unchanged', () => {
  it('lets a host-tenant admin key read another tenant and sleep', async () => {
    const k = key('default', 'admin');
    expect((await audit('?tenant=acme', k)).status).toBe(200);
    expect((await sleep(k)).status).toBe(200);
  });

  it('lets a keyless loopback caller read another tenant and sleep', async () => {
    expect((await audit('?tenant=acme')).status).toBe(200);
    expect((await sleep()).status).toBe(200);
  });

  it('marks the CLI actor as host admin and lets the CLI sleep', () => {
    expect(adminActor('cli').hostAdmin).toBe(true);
    const project = mkdtempSync(join(tmpdir(), 'hippo-host-admin-cli-'));
    try {
      initStore(join(project, '.hippo'));
      const env = { ...process.env, HIPPO_HOME: globalHome, HIPPO_TENANT: 'acme' };
      const res = spawnSync('node', [CLI, 'sleep', '--dry-run'], { cwd: project, env, encoding: 'utf-8' });
      expect(res.status, res.stderr).toBe(0);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('hippo_learn needs a host admin', () => {
  it('gives a member key a permission error over HTTP MCP', async () => {
    const res = await mcpCall('hippo_learn', { days: 1 }, key('default', 'member'));
    expect(res.error?.message).toContain('host admin');
  });

  it('gives a tenant admin a permission error over HTTP MCP', async () => {
    const res = await mcpCall('hippo_learn', { days: 1 }, key('acme', 'admin'));
    expect(res.error?.message).toContain('host admin');
  });

  it('runs for a host-tenant admin key over HTTP MCP', async () => {
    const res = await mcpCall('hippo_learn', { days: 1 }, key('default', 'admin'));
    expect(res.error).toBeUndefined();
  });

  it('runs for an in-process stdio caller', async () => {
    const res = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_learn', arguments: { days: 1 } } },
      { hippoRoot: home, tenantId: 'default', actor: 'mcp' },
    );
    expect(res?.error).toBeUndefined();
  });
});

describe('MCP auto-sleep stays with the host tenant', () => {
  it('does not let another tenant trigger host-wide consolidation', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ autoSleep: { enabled: true, threshold: 1 } }));
    const res = await mcpCall('hippo_remember', { text: 'acme deploys on tuesdays after the freeze' }, key('acme', 'member'));
    expect(res.error).toBeUndefined();
    await new Promise((r) => setTimeout(r, 500));
    expect(sleepRuns()).toBe(0);
  });
});
