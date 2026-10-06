// MCP on a shared store stamps the caller's X-Hippo-Project, refuses memory tools without one, and never stamps the served folder's ''.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { adminActor, learn, MCP_LEARN } from '../src/api.js';
import { _resetSharedStoreCacheForTests } from '../src/config.js';
import type { JsonValue } from '../src/json.js';
import { sharedStoreRefusal } from '../src/mcp/shared-gate.js';
import { TOOLS } from '../src/mcp/tools.js';
import { clearProjectIdentityCache } from '../src/project-identity.js';
import { serve, type ServerHandle } from '../src/server.js';

type ToolReply = { result?: { content: Array<{ text: string }>; isError?: boolean } };
const OFF = ['hippo_learn', 'hippo_share', 'hippo_resolve', 'hippo_peers'];
const OPEN = new Map<string, Record<string, JsonValue>>([['hippo_predict_baserate', { class_tag: 'gate-check' }]]);

let tmp: string;
let handle: ServerHandle | null = null;
const origHome = process.env.HIPPO_HOME;

/** `<tmp>/srv/hippo-team`, a folder with no project marker, so the folder stamp is '' (user-global). */
function flaggedStore(): string {
  const store = path.join(tmp, 'srv', 'hippo-team');
  fs.mkdirSync(store, { recursive: true });
  initStore(store);
  fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ sharedStore: true }));
  return store;
}

async function mcp<T>(h: ServerHandle, method: string, params?: Record<string, JsonValue>, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${h.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  // SAFETY: handleMcpRequest fixes the JSON-RPC envelope; each caller names only the fields it asserts on.
  return (await res.json()) as T;
}

function repoWithOneFix(): string {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }); };
  git('init');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repo, 'db.ts'), 'export const timeout = 30;\n');
  git('add', '.');
  git('commit', '-m', 'fix: pool timeout bumped to 30s in src/db.ts');
  return repo;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-shared-mcp-'));
  process.env.HIPPO_HOME = path.join(tmp, 'global');
  clearProjectIdentityCache();
  _resetSharedStoreCacheForTests();
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  if (origHome === undefined) delete process.env.HIPPO_HOME;
  else process.env.HIPPO_HOME = origHome;
  _resetSharedStoreCacheForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('MCP writes on a shared store', () => {
  it('HTTP MCP hippo_remember with no project header is refused and stores nothing', async () => {
    const store = flaggedStore();
    handle = await serve({ hippoRoot: store, port: 0 });
    const body = await mcp<ToolReply>(handle, 'tools/call', {
      name: 'hippo_remember',
      arguments: { text: 'the staging database restarts at noon on sundays' },
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content[0]?.text).toBe("hippo_remember needs the caller's project on a shared store; the client sends it in the X-Hippo-Project header");
    expect(loadAllEntries(store)).toEqual([]);
  });

  it('HTTP MCP hippo_remember stamps the X-Hippo-Project name', async () => {
    const store = flaggedStore();
    handle = await serve({ hippoRoot: store, port: 0 });
    const body = await mcp<ToolReply>(handle, 'tools/call', {
      name: 'hippo_remember',
      arguments: { text: 'the staging database restarts at noon on sundays' },
    }, { 'x-hippo-project': 'acme' });
    expect(body.result?.content[0]?.text).toMatch(/Remembered/);
    expect(loadAllEntries(store).map((e) => e.origin_project)).toEqual(['acme']);
  });

  it('learn with the MCP profile stores NULL rows', () => {
    const store = flaggedStore();
    const ctx = { hippoRoot: store, tenantId: 'default', actor: adminActor('shared-store-mcp-test') };
    const result = learn(ctx, { repoPath: repoWithOneFix(), days: 7, profile: MCP_LEARN });
    expect(result.added).toBe(1);
    const rows = loadAllEntries(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin_project).toBeNull();
  });

  it('hippo_remember takes exactly text, error, pin, tag and personal', async () => {
    handle = await serve({ hippoRoot: flaggedStore(), port: 0 });
    const body = await mcp<{ result?: { tools: Array<{ name: string; inputSchema: { properties: object } }> } }>(handle, 'tools/list');
    const tool = body.result?.tools.find((t) => t.name === 'hippo_remember');
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(['error', 'personal', 'pin', 'tag', 'text']);
  });
});

describe('the MCP tool gate on a shared store', () => {
  it('turns learn, share, resolve and peers off, opens baserate, and needs a project for every other tool', async () => {
    const store = flaggedStore();
    handle = await serve({ hippoRoot: store, port: 0 });
    const headerSets: Record<string, string>[] = [{}, { 'x-hippo-project': 'acme' }];
    for (const { name } of TOOLS) {
      for (const headers of headerSets) {
        const label = `${name} ${'x-hippo-project' in headers ? 'with' : 'without'} a project`;
        const reply = (await mcp<ToolReply>(handle, 'tools/call', { name, arguments: OPEN.get(name) ?? {} }, headers)).result;
        const text = reply?.content[0]?.text ?? '';
        if (OFF.includes(name)) {
          expect(reply?.isError, label).toBe(true);
          expect(text, label).toMatch(new RegExp(`^${name} is off on a shared store: it `));
        } else if (OPEN.has(name) || 'x-hippo-project' in headers) {
          expect(text, label).not.toMatch(/on a shared store/);
        } else {
          expect(reply?.isError, label).toBe(true);
          expect(text, label).toBe(`${name} needs the caller's project on a shared store; the client sends it in the X-Hippo-Project header`);
        }
      }
    }
    expect(loadAllEntries(store)).toEqual([]);
  });

  it('leaves stdio alone: no context means no shared store to gate', () => {
    for (const { name } of TOOLS) expect(sharedStoreRefusal(name, undefined), name).toBeUndefined();
  });
});
