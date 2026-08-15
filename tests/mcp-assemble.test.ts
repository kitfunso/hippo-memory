/**
 * MCP `hippo_assemble` tool — surface check for Phase 2 assemble API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, MemoryKind } from '../src/memory.js';
import { handleMcpRequest } from '../src/mcp/server.js';

function makeRoot(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}
function safeRmSync(p: string): void { try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }

async function callTool(
  reqId: number,
  name: string,
  args: Record<string, unknown>,
  ctx: { hippoRoot: string; tenantId: string; actor: string; clientKey?: string },
) {
  return handleMcpRequest(
    { jsonrpc: '2.0', id: reqId, method: 'tools/call', params: { name, arguments: args } },
    ctx,
  );
}
function extractText(res: unknown): string {
  const r = res as { result?: { content?: Array<{ text?: string }> } } | null;
  return r?.result?.content?.[0]?.text ?? '';
}

describe('mcp hippo_assemble', () => {
  let home: string;
  let originalHome: string | undefined;
  beforeEach(() => {
    home = makeRoot('mcp-assemble');
    originalHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = home;
  });
  afterEach(() => {
    safeRmSync(home);
    if (originalHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = originalHome;
  });

  it('hippo_assemble is in the tools catalogue', async () => {
    const res = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { hippoRoot: home, tenantId: 'default', actor: 'mcp' },
    );
    const tools = (res as { result?: { tools?: Array<{ name?: string }> } }).result?.tools ?? [];
    expect(tools.map((t) => t.name)).toContain('hippo_assemble');
  });

  it('returns formatted block for a real session', async () => {
    for (let i = 0; i < 3; i++) {
      const e = createMemory(`session message ${i} content`, {
        layer: Layer.Buffer,
        confidence: 'observed',
        kind: 'raw' as MemoryKind,
        source_session_id: 'sess-mcp',
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
