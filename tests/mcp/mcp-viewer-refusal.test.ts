// A viewer's MCP context reads and is refused every write tool before it runs; every tool is classed as read or write.
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { VIEWER_REFUSAL } from '../../src/server.js';
import { handleMcpRequest, type McpContext, type McpResponse } from '../../src/surface/mcp/server.js';
import { mcpActor } from '../../src/surface/mcp/protocol.js';
import { TOOLS, WRITE_TOOLS } from '../../src/surface/mcp/tools.js';
import { loadConfig } from '../../src/host/config-file.js';
import { makeRoot } from '../_helpers/make-root.js';
import { testReach } from '../_helpers/api-ctx.js';
import { testInfra } from '../_helpers/infra.js';
import { mcpContext, type McpCallerFields } from '../_helpers/mcp-context.js';
import type { JsonObject } from '../../src/base/util/json.js';
import { READ_TOOLS, unclassifiedTools } from '../_helpers/mcp-tool-classes.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { sqliteStore } = sessionPerTest();

let root: string;

beforeEach(() => {
  root = makeRoot('mcp-viewer', { config: { embeddings: { enabled: false } } });
  vi.stubEnv('HIPPO_HOME', makeRoot('mcp-viewer-global'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function contextWith(role: string | undefined): McpContext {
  const store = sqliteStore(root);
  // SAFETY: the role is typed as required, yet a caller from an untyped plugin may send none or a wrong one.
  const caller = {
    hippoRoot: root,
    tenantId: 'default',
    actor: 'api_key:hk_viewer',
    role,
    store,
    reach: testReach(root, store),
    config: loadConfig(root),
    infra: testInfra(),
  } as McpCallerFields;
  return mcpContext(caller);
}

function callTool(ctx: McpContext, name: string, args: JsonObject): Promise<McpResponse | null> {
  return handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx);
}

interface ToolResult {
  content?: { text: string }[];
  isError?: boolean;
}

function resultOf(reply: McpResponse | null): ToolResult {
  // SAFETY: the tools/call handler answers with this MCP tool-result shape.
  return (reply?.result ?? {}) as ToolResult;
}

const textOf = (reply: McpResponse | null): string => resultOf(reply).content?.[0]?.text ?? '';
const isError = (reply: McpResponse | null): boolean => resultOf(reply).isError === true;

describe('a viewer context', () => {
  it.each([...WRITE_TOOLS])('is refused %s with the viewer text', async (name) => {
    const reply = await callTool(contextWith('viewer'), name, { text: 'x', id: 'mem_x', force: true });
    expect({ error: isError(reply), text: textOf(reply) }).toEqual({ error: true, text: VIEWER_REFUSAL });
  });

  it('still answers a read tool, and keeps the viewer role on its actor', async () => {
    const ctx = contextWith('viewer');
    const reply = await callTool(ctx, 'hippo_status', {});
    expect(isError(reply)).toBe(false);
    expect(mcpActor(ctx).role).toBe('viewer');
  });
});

describe('a context with no role (guard)', () => {
  it('still runs as a member and writes', async () => {
    const reply = await callTool(contextWith(undefined), 'hippo_remember', { text: 'a roleless note' });
    expect(isError(reply)).toBe(false);
    expect(textOf(reply)).toContain('Remembered [mem_');
    expect(mcpActor(contextWith(undefined)).role).toBe('member');
    expect(mcpActor(contextWith('owner')).role).toBe('member');
  });
});

describe('the tool classes', () => {
  it('place every tool in the read set or the write set', () => {
    const names = TOOLS.map((t) => t.name);
    expect(unclassifiedTools(names)).toEqual([]);
    expect(unclassifiedTools([...names, 'hippo_planted'])).toEqual(['hippo_planted']);
    expect([...READ_TOOLS].filter((name) => WRITE_TOOLS.has(name))).toEqual([]);
  });
});
