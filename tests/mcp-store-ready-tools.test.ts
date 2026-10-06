// Under a store other than hippo.db, MCP lists and runs only the tools that reach their store through the port.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMcpRequest, type McpContext, type McpResponse } from '../src/mcp/server.js';
import { STORE_READY_TOOLS } from '../src/mcp/request.js';
import { TOOLS } from '../src/mcp/tools.js';
import { sqliteStore } from '../src/store-port.js';

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

function listedNames(res: McpResponse | null): string[] {
  // SAFETY: src/mcp/request.ts answers tools/list with { tools: McpToolDefinition[] }.
  const result = res?.result as { tools: { name: string }[] } | undefined;
  return result?.tools.map((t) => t.name) ?? [];
}

const declared = TOOLS.map((t) => t.name);

describe('store-ready MCP tools', () => {
  it('are all declared in TOOLS, and hippo_recall is one', () => {
    expect([...STORE_READY_TOOLS].filter((name) => !declared.includes(name))).toEqual([]);
    expect(STORE_READY_TOOLS.has('hippo_recall')).toBe(true);
  });

  it('tools/list under another store lists only them, in TOOLS order', async () => {
    const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxOn('stub'));
    expect(listedNames(res)).toEqual(declared.filter((name) => STORE_READY_TOOLS.has(name)));
    expect(listedNames(res)).toEqual(['hippo_recall']);
  });

  it.each([['the sqlite store', 'sqlite'], ['a context with no store', undefined]] as const)('tools/list on %s lists every tool', async (_name, kind) => {
    const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxOn(kind));
    expect(listedNames(res)).toEqual(declared);
  });

  it('a call to any other tool under another store answers an error naming the store, and the tool never runs', async () => {
    const unready = declared.filter((name) => !STORE_READY_TOOLS.has(name));
    expect(unready.length).toBeGreaterThan(0);
    for (const name of unready) {
      const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }, ctxOn('stub'));
      expect(res).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: `${name} is not available on the 'stub' store` } });
    }
    expect(readdirSync(root)).toEqual([]);
  });
});
