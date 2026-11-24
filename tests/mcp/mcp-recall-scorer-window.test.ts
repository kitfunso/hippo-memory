import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Layer } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { handleMcpRequest, type McpResponse } from '../../src/surface/mcp/server.js';
import { RecallContractError } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadConfig } from '../../src/host/config-file.js';
import { writeEntry, writeEntriesTogether } from '../_helpers/root-forms.js';
import { removeDir } from '../_helpers/remove-dir.js';
import { testInfra } from '../_helpers/infra.js';
import { mcpContext } from '../_helpers/mcp-context.js';

function callTool(
  name: string,
  args: Record<string, string | number>,
  ctx: { hippoRoot: string; tenantId: string; actor: string },
) {
  return handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    mcpContext({
      ...ctx,
      role: 'admin',
      hostAdmin: true,
      store: sqliteStore(ctx.hippoRoot),
      config: loadConfig(ctx.hippoRoot),
      infra: testInfra(),
    }),
  );
}

function extractResultText(response: McpResponse | null): string {
  // SAFETY: hippo_recall's success response is written by this MCP server
  // under test (src/surface/mcp/server.ts) and always shapes `result` as
  // { content: [{ text: string }, ...] } for a text-content tool result.
  const result = response?.result as { content?: Array<{ text: string }> } | undefined;
  return result?.content?.[0]?.text ?? '';
}

describe('MCP hippo_recall scorer_window', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot('mcp-sw');
    writeEntriesTogether(
      home,
      Array.from({ length: 30 }, (_, i) =>
        createMemory(`alpha ${i}`, {
          layer: Layer.Buffer,
          kind: 'raw',
          tenantId: 'default',
        }),
      ),
    );
  });

  afterEach(() => removeDir(home));

  it.each([0, 'abc'])('scorer_window=%s throws RecallContractError with code=invalid_scorer_window', async (value) => {
    const call = callTool(
      'hippo_recall',
      { query: 'alpha', scorer_window: value },
      { hippoRoot: home, tenantId: 'default', actor: 'mcp' },
    );
    await expect(call).rejects.toBeInstanceOf(RecallContractError);
    await expect(call).rejects.toMatchObject({ code: 'invalid_scorer_window' });
  });

  it('scorer_window+fresh_tail_count exercises the api.recall appendix path', async () => {
    for (let i = 0; i < 5; i++) {
      writeEntry(
        home,
        createMemory(`beta ${i}`, {
          layer: Layer.Buffer,
          kind: 'raw',
          tenantId: 'default',
        }),
      );
    }
    const result = await callTool(
      'hippo_recall',
      { query: 'alpha', budget: 5000, scorer_window: 2, fresh_tail_count: 5 },
      { hippoRoot: home, tenantId: 'default', actor: 'mcp' },
    );
    const text = extractResultText(result);
    expect(text).toContain('Found 30 memories:');
    expect(text).toContain('Fresh tail / substituted summaries');
  });
});
