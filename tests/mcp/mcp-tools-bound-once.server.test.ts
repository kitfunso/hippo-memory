// A server binds its MCP tools once, at boot: a tool call proves the local tier no more.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { serve, type ServerHandle } from '../../src/server.js';
import type { HippoStore } from '../../src/entry/store-kit.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import type { HippoDbStore } from '../../src/api/hippo-db-context.js';
import { bindMcpTools } from '../../src/surface/mcp/request.js';
import {
  mcpApiContext,
  type HippoDbToolCall,
  type McpCaller,
  type McpResponse,
} from '../../src/surface/mcp/protocol.js';
import { jsonAs } from '../_helpers/http-objects-server.js';
import { runAssembleTool, runDrillTool } from '../../src/surface/mcp/recall-tools.js';
import { runStatusTool } from '../../src/surface/mcp/admin-tools.js';
import { loadConfig } from '../../src/host/config-file.js';
import { testInfra } from '../_helpers/infra.js';
import { CLEARED_ENV } from '../_helpers/recall-golden-seed.js';
import { seedTwoTenants, TENANT_A, type TwoTenantFixture } from '../_helpers/store-conformance.js';

type Runner = (call: HippoDbToolCall) => Promise<string>;
// Each call with the tool body it runs, so the tools' own reads can be counted apart from the host.
const CALLS: readonly (readonly [string, Record<string, string>, Runner])[] = [
  ['hippo_drill', { summary_id: 'sum_none' }, runDrillTool],
  ['hippo_assemble', { session_id: 'sess-none' }, runAssembleTool],
  ['hippo_status', {}, runStatusTool],
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

    // The same tool bodies called directly: their reads are the tools' own and nothing else.
    const own = counting(sqliteStore(fixture.dir));
    const caller: McpCaller<HippoDbStore> = {
      hippoRoot: fixture.dir,
      tenantId: TENANT_A,
      actor: 'mcp',
      role: 'admin',
      store: own.store,
      storeFor: (s) => s,
      config: loadConfig(fixture.dir),
      stdio: true,
      infra: testInfra(),
    };
    const { hippoRoot, tenantId, config } = caller;
    for (const [, args, run] of CALLS) {
      const api = { ...mcpApiContext(caller), store: own.store };
      expect(await run({ ctx: caller, hippoRoot, store: own.store, config, tenantId, args, api })).not.toBe('');
    }

    expect(own.reads()).toBeGreaterThan(0);
    expect(served).toBe(own.reads());
  });
});
