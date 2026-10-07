// Under a store other than hippo.db, MCP lists and runs only the tools that reach their store through the port.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STORE_NOT_PORTED_MESSAGE } from '../src/http-util.js';
import { handleMcpRequest, type McpContext, type McpResponse } from '../src/mcp/server.js';
import { TOOLS } from '../src/mcp/tools.js';
import { sqliteStore } from '../src/store-port.js';
import { portOnlyStore } from './_helpers/port-only-store.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-mcp-ready-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// The stub kind wraps a hippo.db store that nothing blocks, so a tool that ran would leave hippo.db behind.
const ctxOn = (kind: string | undefined): McpContext => ({
  hippoRoot: root,
  tenantId: 'default',
  actor: 'mcp',
  store: kind === undefined ? undefined : { ...sqliteStore(root), kind },
});

// An add-on store built before the contextReads group.
const ctxWithoutContextReads = (): McpContext => ({ hippoRoot: root, tenantId: 'default', actor: 'mcp', store: portOnlyStore(root) });

function listedNames(res: McpResponse | null): string[] {
  // SAFETY: src/mcp/request.ts answers tools/list with { tools: McpToolDefinition[] }.
  const result = res?.result as { tools: { name: string }[] } | undefined;
  return result?.tools.map((t) => t.name) ?? [];
}

const declared = TOOLS.map((t) => t.name);
const notPorted = { jsonrpc: '2.0', id: 1, error: { code: -32603, message: STORE_NOT_PORTED_MESSAGE } };
// The stub carries every group sqliteStore sets, so the tools that name one run on it.
const ready = declared.filter((name) => ['hippo_recall', 'hippo_remember', 'hippo_outcome', 'hippo_context'].includes(name));

describe('store-ready MCP tools', () => {
  it('tools/list under another store lists only the tools that name a group it has', async () => {
    const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxOn('stub'));
    expect(listedNames(res)).toEqual(ready);
  });

  it('tools/list under a store without contextReads leaves hippo_context out, and a call to it answers store_not_ported', async () => {
    const listed = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxWithoutContextReads());
    expect(listedNames(listed)).toEqual(['hippo_recall']);
    const called = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_context', arguments: {} } }, ctxWithoutContextReads(),
    );
    expect(called).toEqual(notPorted);
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([['the sqlite store', 'sqlite'], ['a context with no store', undefined]] as const)('tools/list on %s lists every tool', async (_name, kind) => {
    const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxOn(kind));
    expect(listedNames(res)).toEqual(declared);
  });

  it('a call to any other tool under another store answers store_not_ported, and the tool never runs', async () => {
    const unready = declared.filter((name) => !ready.includes(name));
    expect(unready.length).toBeGreaterThan(0);
    for (const name of unready) {
      const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }, ctxOn('stub'));
      expect(res).toEqual(notPorted);
    }
    expect(readdirSync(root)).toEqual([]);
  });
});
