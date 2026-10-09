// Each HTTP request and MCP tool call opens each store it reads once, however many api helpers it runs.
// Counts real DatabaseSync connections per database file by patching the prototype, as the hook open-count test does.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { serve, type AddonRoute, type ServerHandle } from '../src/server.js';
import { handleMcpRequest, type McpResponse } from '../src/mcp/server.js';
import { recall, remember } from '../src/api.js';

interface Connection { location(): string | null }
type ConnectionMethod = (this: Connection, ...args: never[]) => void;

const require = createRequire(import.meta.url);
// SAFETY: node:sqlite has no bundled types; exec and prepare are plain methods on DatabaseSync.prototype.
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: { prototype: Record<'exec' | 'prepare', ConnectionMethod> } };

const seen = new WeakSet<Connection>();
const opened: string[] = [];

function countConnections(): Array<{ mockRestore(): void }> {
  return (['exec', 'prepare'] as const).map((method) => {
    const original = DatabaseSync.prototype[method];
    return vi.spyOn(DatabaseSync.prototype, method).mockImplementation(function (this: Connection, ...args: never[]) {
      if (!seen.has(this)) {
        seen.add(this);
        opened.push(this.location() ?? '');
      }
      return original.apply(this, args);
    });
  });
}

let tmp: string;
let root: string;
let priorHome: string | undefined;
let server: ServerHandle;
let spies: Array<{ mockRestore(): void }>;

/** Connections opened while `fn` ran, per store: `local`, `global`, or the file path. */
async function opensDuring(fn: () => Promise<void>): Promise<Record<string, number>> {
  const start = opened.length;
  await fn();
  const counts: Record<string, number> = {};
  for (const file of opened.slice(start)) {
    const label = resolve(dirname(file)) === resolve(root) ? 'local' : file;
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

interface CallBody { readonly content?: string; readonly jsonrpc?: '2.0' }

async function call(method: string, path: string, body?: CallBody): Promise<void> {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  await res.text();
  expect(res.status).toBeLessThan(300);
}

const recallOverMcp = { jsonrpc: '2.0' as const, id: 1, method: 'tools/call', params: { name: 'hippo_recall', arguments: { query: 'rollback plan' } } };

beforeAll(async () => {
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'hippo-request-open-count-')));
  root = join(tmp, 'store');
  priorHome = process.env.HIPPO_HOME;
  // A global store left by another file in this worker would add its own open to every recall.
  process.env.HIPPO_HOME = join(tmp, 'global');
  initStore(root);
  const opts = { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS };
  writeEntry(root, createMemory('the postgres migration needs a rollback plan and a dry run', opts));
  writeEntry(root, createMemory('deploy windows are Tuesday and Thursday afternoons only', opts));
  spies = countConnections();
  // Boot opens the held connection, so every count below is the requests' own.
  // An add-on route that runs two api helpers, as a hook route does.
  const addon: AddonRoute = { path: '/v1/test/remember-then-recall', handler: async ({ ctx }) => {
    remember(ctx, { content: 'the release train leaves every second Wednesday' });
    return { total: recall(ctx, { query: 'release train' }).total };
  } };
  server = await serve({ hippoRoot: root, port: 0, routes: [addon] });
});

afterAll(async () => {
  await server.stop();
  for (const spy of spies) spy.mockRestore();
  if (priorHome === undefined) delete process.env.HIPPO_HOME;
  else process.env.HIPPO_HOME = priorHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe('store opens per request', () => {
  it("POST /v1/memories opens no connection on the server thread, its write running on the store's writer thread", async () => {
    expect(await opensDuring(() => call('POST', '/v1/memories', { content: 'canary rollouts start at five percent of traffic' }))).toEqual({});
  });

  it('GET /v1/memories (recall) opens the store once', async () => {
    expect(await opensDuring(() => call('GET', '/v1/memories?q=rollback%20plan'))).toEqual({ local: 1 });
  });

  it('MCP hippo_recall over POST /mcp opens the store once', async () => {
    expect(await opensDuring(() => call('POST', '/mcp', recallOverMcp))).toEqual({ local: 1 });
  });

  it('an add-on route opens the store once across the api helpers it runs', async () => {
    expect(await opensDuring(() => call('POST', '/v1/test/remember-then-recall', {}))).toEqual({ local: 1 });
  });

  it('concurrent reads each open their own handle, and a write among them opens none', async () => {
    const requests = async () => void await Promise.all([
      call('GET', '/v1/memories?q=rollback'),
      call('GET', '/v1/memories?q=deploy'),
      call('POST', '/mcp', recallOverMcp),
      call('POST', '/v1/memories', { content: 'the staging database is rebuilt every Sunday night' }),
    ]);
    expect(await opensDuring(requests)).toEqual({ local: 3 });
  });
});

describe('stdio MCP tool calls', () => {
  it('interleaved calls each open and close their own handle', async () => {
    const ctx = { hippoRoot: root, tenantId: 'default', actor: 'mcp' };
    const reply = (id: number, query: string) =>
      handleMcpRequest({ ...recallOverMcp, id, params: { name: 'hippo_recall', arguments: { query } } }, ctx);
    let replies: Array<McpResponse | null> = [];
    const counts = await opensDuring(async () => {
      replies = await Promise.all([reply(1, 'rollback'), reply(2, 'deploy'), reply(3, 'staging')]);
    });
    expect(counts).toEqual({ local: 3 });
    for (const r of replies) expect(r?.error).toBeUndefined();
  });
});
