// Under a store other than hippo.db, MCP lists and runs only the tools that reach their store through the port.
import { beforeEach, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { loadConfig } from '../../src/host/config-file.js';
import { STORE_NOT_PORTED_MESSAGE } from '../../src/base/errors/http-errors.js';
import { handleMcpRequest, type McpContext, type McpResponse } from '../../src/surface/mcp/server.js';
import { TOOLS } from '../../src/surface/mcp/tools.js';
import type { HippoStore } from '../../src/entry/store-kit.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { withoutHippoDb, portOnlyStore } from '../_helpers/port-only-store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { testInfra } from '../_helpers/infra.js';
import { mcpContext } from '../_helpers/mcp-context.js';

let root: string;

beforeEach(() => {
  root = makeRoot('mcp-ready', { init: false });
});

// The stub wraps a hippo.db store that nothing blocks, without the local files or tier, so a tool that ran would leave hippo.db behind.
function storeOfKind(kind: string): HippoStore {
  return kind === 'sqlite' ? sqliteStore(root) : { ...withoutHippoDb(sqliteStore(root)), kind };
}

const ctxWith = (store: HippoStore): McpContext =>
  mcpContext({
    hippoRoot: root,
    tenantId: 'default',
    actor: 'mcp',
    role: 'admin',
    hostAdmin: true,
    store,
    config: loadConfig(root),
    infra: testInfra(),
  });
const ctxOn = (kind: string): McpContext => ctxWith(storeOfKind(kind));

function listedNames(res: McpResponse | null): string[] {
  // SAFETY: src/surface/mcp/request.ts answers tools/list with { tools: McpToolDefinition[] }.
  const result = res?.result as { tools: { name: string }[] } | undefined;
  return result?.tools.map((t) => t.name) ?? [];
}

const declared = TOOLS.map((t) => t.name);
const notPorted = { jsonrpc: '2.0', id: 1, error: { code: -32603, message: STORE_NOT_PORTED_MESSAGE } };
// The stub lacks the local files and hippo.db's local tier, so every tool but the nine that need them runs on it.
const READY = ['hippo_recall', 'hippo_remember', 'hippo_outcome', 'hippo_context'];
const ready = declared.filter((name) => READY.includes(name));

describe('store-ready MCP tools', () => {
  it('tools/list under another store lists only the tools that need no local tier', async () => {
    const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxOn('stub'));
    expect(listedNames(res)).toEqual(ready);
  });

  it.each([
    ['the sqlite store', 'sqlite'],
    ['stdio, which brings no context for a list', undefined],
  ] as const)('tools/list on %s lists every tool', async (_name, kind) => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' } as const;
    const res =
      kind === undefined ? await handleMcpRequest(list, undefined) : await handleMcpRequest(list, ctxOn(kind));
    expect(listedNames(res)).toEqual(declared);
  });

  it('a call to any other tool under another store answers store_not_ported, and the tool never runs', async () => {
    const unready = declared.filter((name) => !ready.includes(name));
    expect(unready).toEqual([
      'hippo_assemble',
      'hippo_drill',
      'hippo_status',
      'hippo_learn',
      'hippo_conflicts',
      'hippo_resolve',
      'hippo_share',
      'hippo_peers',
      'hippo_predict_baserate',
    ]);
    for (const name of unready) {
      const res = await handleMcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
        ctxOn('stub'),
      );
      expect(res).toEqual(notPorted);
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it('a core-only store binds no tool that needs the local tier: a list hides each, a call answers store_not_ported', async () => {
    const smallest = ctxWith(portOnlyStore(root));
    const featured = [
      'hippo_assemble',
      'hippo_drill',
      'hippo_predict_baserate',
      'hippo_status',
      'hippo_learn',
      'hippo_conflicts',
      'hippo_resolve',
    ];
    const unbound = [...featured, 'hippo_share', 'hippo_peers'];
    const list = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, smallest);
    expect(listedNames(list)).toEqual(declared.filter((name) => !unbound.includes(name)));
    for (const name of featured) {
      const res = await handleMcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
        smallest,
      );
      expect(res).toEqual(notPorted);
    }
    expect(readdirSync(root)).toEqual([]);
  });
});
