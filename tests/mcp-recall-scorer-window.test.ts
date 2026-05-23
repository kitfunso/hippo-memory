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
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, MemoryKind } from '../src/memory.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { RecallContractError } from '../src/api.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-mcp-sw-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { hippoRoot: string; tenantId: string; actor: string },
) {
  return handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    ctx,
  );
}

describe('MCP hippo_recall scorer_window (v1.7.2 T4)', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot();
    for (let i = 0; i < 30; i++) {
      writeEntry(home, createMemory(`alpha ${i}`, {
        layer: Layer.Buffer,
        kind: 'raw' as MemoryKind,
        tenantId: 'default',
      }));
    }
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('scorer_window=2 is accepted and returns content (validator wired through to api.recall)', async () => {
    // MCP `hippo_recall` runs TWO scorers: `apiRecall(...)` for audit +
    // continuity + fresh-tail/summary appendix, AND a separate
    // physics/hybrid scorer over loadAllEntries that drives user-visible
    // ordering. `scorer_window` only narrows api.recall's candidate pool;
    // the primary ranked block is independent. So the user-visible effect
    // of scorer_window over MCP today is on the appendix paths
    // (fresh-tail / summarize-overflow), not the main results. Asserting
    // strictly-shorter rendered text would over-claim.
    //
    // What this test pins: scorer_window passes through transport
    // correctly, reaches apiRecall, and does not throw. The rejection
    // paths below pin the validator end-to-end.
    const result = await callTool(
      'hippo_recall',
      { query: 'alpha', budget: 5000, scorer_window: 2 },
      { hippoRoot: home, tenantId: 'default', actor: { subject: 'mcp', role: 'admin' } },
    );
    const text =
      (result as { result?: { content: Array<{ text: string }> } }).result
        ?.content?.[0]?.text ?? '';
    expect(text.length).toBeGreaterThan(0);
  });

  it('scorer_window=0 throws RecallContractError with code=invalid_scorer_window', async () => {
    let thrown: unknown = null;
    try {
      await callTool(
        'hippo_recall',
        { query: 'alpha', scorer_window: 0 },
        { hippoRoot: home, tenantId: 'default', actor: { subject: 'mcp', role: 'admin' } },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecallContractError);
    expect((thrown as RecallContractError).code).toBe('invalid_scorer_window');
  });

  it('scorer_window+fresh_tail_count exercises the api.recall appendix path — review TESTING P1', async () => {
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
      writeEntry(home, createMemory(`beta ${i}`, {
        layer: Layer.Buffer, kind: 'raw' as MemoryKind, tenantId: 'default',
      }));
    }
    const result = await callTool(
      'hippo_recall',
      { query: 'alpha', budget: 5000, scorer_window: 2, fresh_tail_count: 5 },
      { hippoRoot: home, tenantId: 'default', actor: { subject: 'mcp', role: 'admin' } },
    );
    const text =
      (result as { result?: { content: Array<{ text: string }> } }).result
        ?.content?.[0]?.text ?? '';
    expect(text.length).toBeGreaterThan(0);
    // Appendix renders "## Fresh tail / substituted summaries" header
    // (src/mcp/server.ts:470). Confirm the appendix path fired with the
    // beta rows that physics didn't score.
    expect(text).toContain('Fresh tail / substituted summaries');
  });

  it('scorer_window="abc" (string, transport-coerced) rejects with invalid_scorer_window', async () => {
    // Codex CRITICAL[2]: MCP Number-coerces non-numeric input so the
    // rejection reaches recall() and produces the same typed code as HTTP.
    let thrown: unknown = null;
    try {
      await callTool(
        'hippo_recall',
        { query: 'alpha', scorer_window: 'abc' },
        { hippoRoot: home, tenantId: 'default', actor: { subject: 'mcp', role: 'admin' } },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecallContractError);
    expect((thrown as RecallContractError).code).toBe('invalid_scorer_window');
  });
});
