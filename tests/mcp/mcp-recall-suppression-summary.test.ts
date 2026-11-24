import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Layer } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { handleMcpRequest, type McpContext, type McpResponse } from '../../src/surface/mcp/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadConfig } from '../../src/host/config-file.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';
import { removeDir } from '../_helpers/remove-dir.js';
import { testInfra } from '../_helpers/infra.js';
import { mcpContext } from '../_helpers/mcp-context.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function callTool(reqId: number, name: string, args: Record<string, string | number | boolean>, ctx: McpContext) {
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

function extractText(res: McpResponse | null): string {
  // SAFETY: every hippo_recall tool response in this suite carries a
  // single MCP text content block; the server's own formatter built it.
  const result = res?.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? '';
}

describe('mcp hippo_recall Cutoff suppressionSummary', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot('mcp-c5');
    vi.stubEnv('HIPPO_HOME', home);
  });

  afterEach(() => {
    removeDir(home);
  });

  it('MCP text response includes Cutoff block when filter activity is non-zero', async () => {
    writeEntriesTogether(
      home,
      Array.from({ length: 30 }, (_, i) =>
        createMemory(`omega ${i} ${'padding text '.repeat(20)}`, {
          layer: Layer.Buffer,
          kind: 'raw',
          tenantId: 'default',
        }),
      ),
    );
    const res = await callTool(
      1,
      'hippo_recall',
      { query: 'omega', budget: 200 },
      mcpContext({
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp:test',
        role: 'admin',
        hostAdmin: true,
        store: sqliteStore(home),
        config: loadConfig(home),
        infra: testInfra(),
      }),
    );
    const text = extractText(res);
    expect(text).toMatch(/## Cutoff\nShowing \d+ of \d+ candidates;/);
  });

  it('MCP Cutoff line reflects MCP physics/hybrid pipeline counts (NOT api.recall pipeline counts)', async () => {
    writeEntriesTogether(
      home,
      Array.from({ length: 30 }, (_, i) =>
        createMemory(`omega ${i} ${'padding text '.repeat(20)}`, {
          layer: Layer.Buffer,
          kind: 'raw',
          tenantId: 'default',
        }),
      ),
    );
    const res = await callTool(
      2,
      'hippo_recall',
      { query: 'omega', budget: 200 },
      mcpContext({
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp:test',
        role: 'admin',
        hostAdmin: true,
        store: sqliteStore(home),
        config: loadConfig(home),
        infra: testInfra(),
      }),
    );
    const text = extractText(res);
    const match = text.match(/Showing (\d+) of (\d+) candidates;/);
    expect(match).not.toBeNull();
    if (match) {
      const totalShown = parseInt(match[1], 10);
      const totalCandidates = parseInt(match[2], 10);
      expect(totalCandidates).toBe(30);
      expect(totalShown).toBe(2);
    }
  });

  it('no Cutoff block when memory store is empty (no non-zero counters)', async () => {
    const res = await callTool(
      3,
      'hippo_recall',
      { query: 'nothing' },
      mcpContext({
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp:test',
        role: 'admin',
        hostAdmin: true,
        store: sqliteStore(home),
        config: loadConfig(home),
        infra: testInfra(),
      }),
    );
    const text = extractText(res);
    expect(text).not.toMatch(/## Cutoff/);
    expect(text).not.toMatch(/WYSIATI:/);
  });

  it('top-placement guard: Cutoff block appears BEFORE the first memory row', async () => {
    writeEntriesTogether(
      home,
      Array.from({ length: 30 }, (_, i) =>
        createMemory(`omega ${i} ${'padding text '.repeat(20)}`, {
          layer: Layer.Buffer,
          kind: 'raw',
          tenantId: 'default',
        }),
      ),
    );
    const res = await callTool(
      4,
      'hippo_recall',
      { query: 'omega', budget: 200 },
      mcpContext({
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp:test',
        role: 'admin',
        hostAdmin: true,
        store: sqliteStore(home),
        config: loadConfig(home),
        infra: testInfra(),
      }),
    );
    const text = extractText(res);
    const cutoffIdx = text.indexOf('## Cutoff');
    const firstMemoryIdx = text.search(/^Found \d+ memories:/m);
    expect(cutoffIdx).toBeGreaterThanOrEqual(0);
    expect(firstMemoryIdx).toBeGreaterThanOrEqual(0);
    expect(cutoffIdx).toBeLessThan(firstMemoryIdx);
  });
});
