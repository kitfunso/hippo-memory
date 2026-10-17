/**
 * MCP `hippo_assemble` tool — surface check for Phase 2 assemble API.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../../src/store/entry-writes.js';
import { Layer} from '../../src/core/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { handleMcpRequest, type McpResponse } from '../../src/mcp/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function safeRmSync(p: string): void { try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }

async function callTool(
  reqId: number,
  name: string,
  args: Record<string, string | number | boolean>,
  ctx: { hippoRoot: string; tenantId: string; actor: string; clientKey?: string },
) {
  return handleMcpRequest(
    { jsonrpc: '2.0', id: reqId, method: 'tools/call', params: { name, arguments: args } },
    { ...ctx, role: 'admin', hostAdmin: true, store: sqliteStore(ctx.hippoRoot) },
  );
}
function extractText(res: McpResponse | null): string {
  // SAFETY: every hippo_assemble tool response in this suite carries a
  // single MCP text content block; the server's own formatter built it.
  const result = res?.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? '';
}

describe('mcp hippo_assemble', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('mcp-assemble');
    vi.stubEnv('HIPPO_HOME', home);
  });
  afterEach(() => {
    safeRmSync(home);
  });

  it('hippo_assemble is in the tools catalogue', async () => {
    const res = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { hippoRoot: home, tenantId: 'default', actor: 'mcp', role: 'admin', hostAdmin: true, store: sqliteStore(home) },
    );
    // SAFETY: tools/list always returns { tools: [...] } per the MCP protocol handler above.
    const listResult = res?.result as { tools?: Array<{ name?: string }> } | undefined;
    const tools = listResult?.tools ?? [];
    expect(tools.map((t) => t.name)).toContain('hippo_assemble');
  });

  it('returns formatted block for a real session', async () => {
    for (let i = 0; i < 3; i++) {
      const e = createMemory(`session message ${i} content`, {
        layer: Layer.Buffer,
        confidence: 'observed',
        kind: 'raw',
        sourceSessionId: 'sess-mcp',
        tenantId: 'default',
      });
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(home, e);
    }
    const res = await callTool(2, 'hippo_assemble', { session_id: 'sess-mcp' }, {
      hippoRoot: home, tenantId: 'default', actor: 'mcp',
    });
    const text = extractText(res);
    expect(text).toContain('sess-mcp');
    expect(text).toContain('session message 0');
    expect(text).toContain('session message 2');
  });

  it('rejects empty session_id', async () => {
    const res = await callTool(3, 'hippo_assemble', { session_id: '' }, {
      hippoRoot: home, tenantId: 'default', actor: 'mcp',
    });
    expect(extractText(res).toLowerCase()).toContain('no session_id');
  });

  it('clean empty result for unknown session', async () => {
    const res = await callTool(4, 'hippo_assemble', { session_id: 'sess-nope' }, {
      hippoRoot: home, tenantId: 'default', actor: 'mcp',
    });
    const text = extractText(res);
    expect(text).toContain('0 items');
  });
});
