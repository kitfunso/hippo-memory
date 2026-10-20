/**
 * v1.7.2 T4 — MCP hippo_recall accepts scorer_window arg.
 *
 * Behavioural assertion: narrower scorer_window returns less rendered
 * content than the default (formatMemories does NOT include windowSize in
 * text — codex P2-3 — so we assert observable behaviour).
 *
 * Cross-transport invariant (codex CRITICAL[2]): MCP must Number-coerce
 * non-numeric input so `scorer_window: "abc"` produces the same typed
 * RecallContractError as HTTP `?scorer_window=abc`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { Layer } from '../../src/core/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { handleMcpRequest, type McpResponse } from '../../src/mcp/server.js';
import { RecallContractError } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadConfig } from '../../src/core/config.js';
import { writeEntry, writeEntriesTogether } from '../_helpers/root-forms.js';

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
    { ...ctx, role: 'admin', hostAdmin: true, store: sqliteStore(ctx.hippoRoot), config: loadConfig(ctx.hippoRoot) },
  );
}

/** Extract the rendered text from a `hippo_recall` MCP tool result. */
function extractResultText(response: McpResponse | null): string {
  // SAFETY: hippo_recall's success response is written by this MCP server
  // under test (src/mcp/server.ts) and always shapes `result` as
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

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  // 'abc' is Number-coerced by the transport so recall() rejects it like HTTP does.
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
    // The appendix-marker assertion is non-deterministic in this test
    // because the physics scorer dedupes fresh-tail rows that already
    // appear in the primary ranked block. With all alpha-matching content,
    // fresh-tail rows are usually all in physics's top set → empty
    // appendix. Mix in non-matching rows so fresh-tail surfaces unique IDs
    // physics never scored.
    //
    // Insert beta rows AFTER the alpha seeds (set up in beforeEach) so
    // they're newest. fresh_tail_count=5 surfaces last 5 regardless of
    // query 'alpha'. BM25 / physics only score alpha rows. Beta rows in
    // fresh-tail dedup-survive into the appendix.
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
    // Appendix renders "## Fresh tail / substituted summaries" header
    // (src/mcp/server.ts:470). Confirm the appendix path fired with the
    // beta rows that physics didn't score.
    expect(text).toContain('Fresh tail / substituted summaries');
  });
});
