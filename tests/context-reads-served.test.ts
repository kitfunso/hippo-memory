// GET /v1/context and the hippo_context MCP tool answer the same over serve() on hippo.db and on a store held in memory,
// and a store without contextReads answers store_not_ported on both.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetAblationCacheForTests } from '../src/ablation.js';
import { _resetSharedStoreCacheForTests, markSharedStore } from '../src/config.js';
import { STORE_NOT_PORTED_MESSAGE } from '../src/http-util.js';
import { lastRecalledIds } from '../src/mcp/session-state.js';
import { serve, sqliteStore, type HippoStore } from '../src/server.js';
import { CONTEXT_NOW, contextRowsOf, PROJECT, rounded, seedContextRows } from './_helpers/context-fixture.js';
import { inMemoryContextStore } from './_helpers/in-memory-context-store.js';
import { portOnlyStore } from './_helpers/port-only-store.js';
import { CLEARED_ENV } from './_helpers/recall-golden-seed.js';
import { seedTwoTenants, type TwoTenantFixture } from './_helpers/store-conformance.js';

type Call = { readonly via: 'http'; readonly query: string } | { readonly via: 'mcp'; readonly args: { readonly scope?: string } };
interface Reply { readonly status: number; readonly body: unknown }

const CALLS: readonly Call[] = [
  { via: 'http', query: `project=${PROJECT}` },
  { via: 'http', query: `project=${PROJECT}&q=rollout` },
  { via: 'http', query: `project=${PROJECT}&pinned_only=true&include_recent=4` },
  { via: 'mcp', args: {} },
  { via: 'mcp', args: { scope: 'team:eng' } },
];

let fixture: TwoTenantFixture;

async function send(url: string, call: Call): Promise<Reply> {
  const authorization = `Bearer ${fixture.tokens.adminA}`;
  if (call.via === 'http') {
    const res = await fetch(`${url}/v1/context?${call.query}`, { headers: { authorization } });
    return { status: res.status, body: await res.json() };
  }
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_context', arguments: call.args } };
  const headers = { authorization, 'content-type': 'application/json', 'x-hippo-project': PROJECT };
  const res = await fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify(rpc) });
  return { status: res.status, body: await res.json() };
}

/** Every call over serve() on a fresh copy of the fixture, with no global store. */
async function runServed(makeStore?: (root: string) => HippoStore) {
  _resetSharedStoreCacheForTests();
  _resetAblationCacheForTests();
  lastRecalledIds.clear();
  const home = mkdtempSync(join(tmpdir(), 'hippo-context-served-'));
  try {
    const root = join(home, 'store');
    cpSync(fixture.dir, root, { recursive: true });
    vi.stubEnv('HIPPO_HOME', join(home, 'global'));
    // serve() marks another store's root shared, so the hippo.db pass is shared too to compare like with like.
    markSharedStore(root);
    const store = makeStore?.(root);
    const handle = await serve({ hippoRoot: root, port: 0, store });
    const replies: Reply[] = [];
    try {
      for (const call of CALLS) replies.push(await send(handle.url, call));
    } finally {
      await handle.stop();
      await store?.close();
    }
    return { replies: rounded(replies), rows: contextRowsOf(root) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

beforeAll(() => {
  fixture = seedTwoTenants();
  seedContextRows(fixture.dir);
}, 120_000);

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of CLEARED_ENV) vi.stubEnv(k, '');
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  vi.stubEnv('HIPPO_V1_RPS', '0');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(CONTEXT_NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  _resetSharedStoreCacheForTests();
  _resetAblationCacheForTests();
});

describe('context over serve()', () => {
  it('answers and writes the same on hippo.db and on a store held in memory', async () => {
    const onHippoDb = await runServed();
    expect(onHippoDb.replies.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(JSON.stringify(onHippoDb.replies)).toContain('rollout');
    const inMemory = await runServed((root) => inMemoryContextStore(root).store);
    expect(inMemory.replies).toEqual(onHippoDb.replies);
    expect(inMemory.rows).toEqual(onHippoDb.rows);
    // The default store answers the data-only context reads from worker threads; the same store in process must agree with it.
    const inProcess = await runServed(sqliteStore);
    expect(onHippoDb.replies).toEqual(inProcess.replies);
    expect(onHippoDb.rows).toEqual(inProcess.rows);
  }, 120_000);

  it('a store without contextReads answers store_not_ported on the route and the tool', async () => {
    const { replies } = await runServed(portOnlyStore);
    const mcpRefusal = { status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: -32603, message: STORE_NOT_PORTED_MESSAGE } } };
    const httpRefusal = { status: 501, body: { error: STORE_NOT_PORTED_MESSAGE } };
    expect(replies).toEqual([httpRefusal, httpRefusal, httpRefusal, mcpRefusal, mcpRefusal]);
  }, 120_000);
});
