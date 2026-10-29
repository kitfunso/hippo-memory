// A server binds its MCP tools once, at boot: a tool call proves no group need again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { serve, type ServerHandle } from '../../src/server.js';
import type { HippoStore } from '../../src/entry/store-kit.js';
import { portOnlyStore } from '../_helpers/port-only-store.js';
import { bindMcpTools } from '../../src/surface/mcp/request.js';
import { mcpApiContext, type GroupToolCall, type McpCaller, type McpResponse } from '../../src/surface/mcp/protocol.js';
import { jsonAs } from '../_helpers/http-objects-server.js';
import { runAssembleTool, runDrillTool } from '../../src/surface/mcp/recall-tools.js';
import { runStatusTool } from '../../src/surface/mcp/admin-tools.js';
import { loadConfig } from '../../src/host/config-file.js';
import { testInfra } from '../_helpers/infra.js';
import type { StoreWith } from '../../src/base/ports/store.js';
import { CLEARED_ENV } from '../_helpers/recall-golden-seed.js';
import { seedTwoTenants, TENANT_A, type TwoTenantFixture } from '../_helpers/store-conformance.js';

// The groups the three called tools need.
const NEEDED = ['dagReads', 'reports'] as const;
type Needed = StoreWith<(typeof NEEDED)[number]>;
type Runner = (call: GroupToolCall<(typeof NEEDED)[number]>) => Promise<string>;
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

/** A store that counts every read of a NEEDED group property, whatever function makes it. */
interface CountingStore<S extends HippoStore> {
  readonly store: S;
  readonly reads: () => number;
}

function counting<S extends Needed>(store: S): CountingStore<S> {
  let reads = 0;
  const counted = { ...store };
  for (const group of NEEDED) {
    const value = store[group];
    Object.defineProperty(counted, group, {
      enumerable: true,
      get: () => {
        reads += 1;
        return value;
      },
    });
  }
  return { store: counted, reads: () => reads };
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
    const { store, reads } = counting(portOnlyStore(fixture.dir, [...NEEDED]));
    const alone = counting(portOnlyStore(fixture.dir, [...NEEDED]));
    bindMcpTools(alone.store);
    // One bind reads each group a tool needs, so the count is live.
    expect(alone.reads()).toBeGreaterThan(0);

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
    const own = counting(portOnlyStore(fixture.dir, [...NEEDED]));
    const caller: McpCaller<Needed> = {
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
