/**
 * MCP `hippo_drill` tool — surface check for the v1.5.0 drillDown API.
 *
 * Verifies: tool is in the catalogue, returns formatted output for a real
 * summary, errors cleanly on a leaf id, errors cleanly on a cross-tenant id.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import { handleMcpRequest } from '../src/mcp/server.js';

function makeRoot(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

async function callTool(
  reqId: number,
  name: string,
  args: Record<string, unknown>,
  ctx: { hippoRoot: string; tenantId: string; actor: string; clientKey?: string },
) {
  return handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: reqId,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    ctx,
  );
}

function extractText(res: unknown): string {
  const r = res as { result?: { content?: Array<{ text?: string }> } } | null;
  return r?.result?.content?.[0]?.text ?? '';
}

describe('mcp hippo_drill', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = makeRoot('mcp-drill');
    originalHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = home;
  });

  afterEach(() => {
    safeRmSync(home);
    if (originalHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = originalHome;
  });

  it('hippo_drill is registered in the tools catalogue', async () => {
    const res = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { hippoRoot: home, tenantId: 'default', actor: 'mcp' },
    );
    const tools = (res as { result?: { tools?: Array<{ name?: string }> } }).result?.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).toContain('hippo_drill');
  });

  it('returns formatted summary + children for a valid level-2 summary', async () => {
    const summary: MemoryEntry = createMemory('topic alpha rollup', {
      layer: Layer.Semantic,
      tags: ['dag-summary', 'topic:alpha'],
      confidence: 'inferred',
      dag_level: 2,
    });
    summary.descendant_count = 3;
    writeEntry(home, summary);
    for (let i = 0; i < 3; i++) {
      const c = createMemory(`alpha detail event ${i}`, {
        layer: Layer.Episodic,
        confidence: 'observed',
        dag_level: 1,
        dag_parent_id: summary.id,
      });
      writeEntry(home, c);
    }

    const res = await callTool(2, 'hippo_drill', { summary_id: summary.id }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
    });
    const text = extractText(res);
    expect(text).toContain(summary.id);
    expect(text).toContain('3 descendants');
    expect(text).toContain('alpha detail event 0');
  });

  it('errors on a leaf id', async () => {
    const leaf = createMemory('plain leaf body', {
      layer: Layer.Buffer,
      confidence: 'observed',
      dag_level: 0,
    });
    writeEntry(home, leaf);
    const res = await callTool(3, 'hippo_drill', { summary_id: leaf.id }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
    });
    const text = extractText(res);
    expect(text.toLowerCase()).toContain('not');
  });

  it('errors on a cross-tenant id', async () => {
    const summary: MemoryEntry = createMemory('other tenant summary', {
      layer: Layer.Semantic,
      tags: ['dag-summary'],
      confidence: 'inferred',
      dag_level: 2,
      tenantId: 'other',
    });
    writeEntry(home, summary);
    const res = await callTool(4, 'hippo_drill', { summary_id: summary.id }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
    });
    const text = extractText(res);
    expect(text.toLowerCase()).toContain('not');
  });

  it('rejects empty summary_id', async () => {
    const res = await callTool(5, 'hippo_drill', { summary_id: '' }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
    });
    const text = extractText(res);
    expect(text.toLowerCase()).toContain('no summary_id');
  });
});
