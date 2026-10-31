// A server binds its MCP tools once, at boot: a tool call proves the local tier no more.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { serve, type ServerHandle } from '../../src/server.js';
import type { HippoStore } from '../../src/entry/store-kit.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import type { HippoDbStore } from '../../src/api/hippo-db-context.js';
import { allMcpTools, bindMcpTools } from '../../src/surface/mcp/request.js';
import type { McpContext, McpResponse } from '../../src/surface/mcp/protocol.js';
import { jsonAs } from '../_helpers/http-objects-server.js';
import { loadConfig } from '../../src/host/config-file.js';
import { testInfra } from '../_helpers/infra.js';
import { runMcpTool } from '../_helpers/mcp-context.js';
import { CLEARED_ENV } from '../_helpers/recall-golden-seed.js';
import { seedTwoTenants, TENANT_A, type TwoTenantFixture } from '../_helpers/store-conformance.js';

// Three tools that read the tier groups the counting store watches.
const CALLS: readonly (readonly [string, Record<string, string>])[] = [
  ['hippo_drill', { summary_id: 'sum_none' }],
  ['hippo_assemble', { session_id: 'sess-none' }],
  ['hippo_status', {}],
];

/** A reply from a tool that ran: a result with content, neither an error nor a refusal. */
function expectRan(reply: McpResponse): void {
  expect(reply).toMatchObject({ result: { content: [{ type: 'text' }] } });
  expect(reply).not.toMatchObject({ result: { isError: true } });
}

/** A store that counts every read of its local tier, and apart from those every read of the tier groups the
 * three tools use, whatever function makes it. */
interface CountingStore<S extends HippoStore> {
  readonly store: S;
  readonly reads: () => number;
  readonly tierReads: () => number;
}

function counting<S extends HippoDbStore>(store: S): CountingStore<S> {
  const counts = { group: 0, tier: 0 };
  const countedReads = <H, K extends keyof H>(holder: H, key: K, as: keyof typeof counts): void => {
    const value = holder[key];
    Object.defineProperty(holder, key, {
      enumerable: true,
      get: () => {
        counts[as] += 1;
        return value;
      },
    });
  };
  // A tier group is read through `hippoDb`, so its count sits on the tier's copy. The store copy
  // keeps the hippo.db mark but not the session reopen, so a request uses it as it is.
  const tier = { ...store.hippoDb };
  const counted = { ...store, hippoDb: tier };
  countedReads(counted, 'hippoDb', 'tier');
  countedReads(tier, 'dagReads', 'group');
  countedReads(tier, 'reports', 'group');
  return { store: counted, reads: () => counts.group, tierReads: () => counts.tier };
}

describe('MCP tools on a served store', () => {
  let fixture: TwoTenantFixture;
  let handle: ServerHandle | undefined;

  beforeEach(() => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    vi.stubEnv('HIPPO_V1_RPS', '0');
    fixture = seedTwoTenants();
    vi.stubEnv('HIPPO_HOME', join(fixture.dir, 'no-global'));
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it('binds each tool on one host store once, so three tool calls read their groups only as the tools themselves do', async () => {
    const { store, reads } = counting(sqliteStore(fixture.dir));
    const alone = counting(sqliteStore(fixture.dir));
    bindMcpTools(alone.store);
    // A bind proves the tier and reads no group in it, so every group read below is a tool body's.
    expect(alone.tierReads()).toBeGreaterThan(0);
    expect(alone.reads()).toBe(0);

    handle = await serve({ hippoRoot: fixture.dir, port: 0, store });
    const atBoot = reads();
    for (const [name, args] of CALLS) {
      const res = await fetch(`${handle.url}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${fixture.tokens.adminA}`,
          'content-type': 'application/json',
          'x-hippo-project': 'acme-app',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      expectRan(await jsonAs<McpResponse>(res));
    }
    const served = reads() - atBoot;

    // The same tools run with no server around them: their reads are the tools' own and nothing else.
    const own = counting(sqliteStore(fixture.dir));
    const caller: McpContext<HippoDbStore> = {
      hippoRoot: fixture.dir,
      tenantId: TENANT_A,
      actor: 'mcp',
      role: 'admin',
      store: own.store,
      storeFor: (s) => s,
      config: loadConfig(fixture.dir),
      stdio: true,
      infra: testInfra(),
      tools: allMcpTools(),
    };
    for (const [name, args] of CALLS) {
      expect(await runMcpTool(caller, name, args)).not.toBe('');
    }

    expect(own.reads()).toBeGreaterThan(0);
    expect(served).toBe(own.reads());
  });
});
