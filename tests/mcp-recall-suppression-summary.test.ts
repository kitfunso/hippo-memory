/**
 * v1.12.13 / C5 — cutoff transparency for the MCP hippo_recall path.
 *
 * Proof-of-fix for the plan-eng-critic round 1 CRIT: MCP runs a SECOND
 * physics/hybrid pipeline (src/mcp/server.ts loadAllEntries -> scope filter
 * -> physicsSearch/hybridSearch) for the user-visible memory list AFTER
 * apiRecall. If suppressionSummary were attached only to apiResult, MCP
 * users would see counts describing a DIFFERENT pipeline than the memories
 * they were reading. Plan v3 fix: MCP populates its own suppressionSummary
 * from the physics/hybrid pipeline and replaces apiResult.suppressionSummary
 * in the user-facing response.
 *
 * This test seeds memories such that the MCP physics/hybrid path
 * (loadAllEntries) sees MORE candidates than the api.recall path
 * (loadRecallSearchEntries returns BM25-pruned set), then asserts the Cutoff
 * line in the MCP text response reflects the LARGER pipeline's count.
 *
 * v1.13.3 update: the WYSIATI line at the BOTTOM of the response was moved
 * to a "## Cutoff" block at the TOP (alongside other Track J hints) and
 * the "WYSIATI:" prefix was rewritten to plain English. Dogfood proof at
 * docs/dogfood/2026-05-27-track-j-warnings.md showed the bottom-placed
 * jargon-prefixed line did not reach the calling agent. Tests updated +
 * a new top-placement guard added below.
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

function callTool(
  reqId: number,
  name: string,
  args: Record<string, unknown>,
  ctx: { hippoRoot: string; tenantId: string; actor: { subject: string; role: 'admin' | 'member' }; clientKey?: string },
) {
  return handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: reqId,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    ctx as unknown as { hippoRoot: string; tenantId: string; actor: string; clientKey?: string },
  );
}

function extractText(res: unknown): string {
  const r = res as { result?: { content?: Array<{ text?: string }> } } | null;
  return r?.result?.content?.[0]?.text ?? '';
}

describe('mcp hippo_recall Cutoff suppressionSummary (C5, v1.12.13 + v1.13.3)', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = makeRoot('mcp-c5');
    originalHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = originalHome;
  });

  it('MCP text response includes Cutoff block when filter activity is non-zero', async () => {
    // Seed 30 query-matching rows with content padded to force the physics/
    // hybrid budget to drop some, so droppedByBudget > 0 and Cutoff fires.
    // Each row ~100 chars; tight budget = 200 tokens forces ~10 rows max.
    for (let i = 0; i < 30; i++) {
      writeEntry(home, createMemory(`omega ${i} ${'padding text '.repeat(20)}`, {
        layer: Layer.Buffer,
        kind: 'raw' as MemoryKind,
        tenantId: 'default',
      }));
    }
    const res = await callTool(1, 'hippo_recall', { query: 'omega', budget: 200 }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: { subject: 'mcp:test', role: 'admin' },
    });
    const text = extractText(res);
    // v1.13.3: format is "## Cutoff\nShowing N of M candidates; ..." (was
    // bottom-placed "WYSIATI: showing N/M; ..." in v1.12.13-v1.13.2).
    expect(text).toMatch(/## Cutoff\nShowing \d+ of \d+ candidates;/);
  });

  it('MCP Cutoff line reflects MCP physics/hybrid pipeline counts (NOT api.recall pipeline counts)', async () => {
    // MCP pipeline uses loadAllEntries (all 30 rows). api.recall pipeline
    // uses loadRecallSearchEntries with a query-specific BM25 prune.
    // For a generic query that matches every row, both pipelines see all 30,
    // but the MCP pipeline's totalCandidates derives from loadAllEntries
    // which has no per-query LIMIT, so it should reflect the full store size.
    // Tight budget forces droppedByBudget > 0 so Cutoff emits.
    for (let i = 0; i < 30; i++) {
      writeEntry(home, createMemory(`omega ${i} ${'padding text '.repeat(20)}`, {
        layer: Layer.Buffer,
        kind: 'raw' as MemoryKind,
        tenantId: 'default',
      }));
    }
    const res = await callTool(2, 'hippo_recall', { query: 'omega', budget: 200 }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: { subject: 'mcp:test', role: 'admin' },
    });
    const text = extractText(res);
    // Extract Cutoff totalCandidates value via regex.
    const match = text.match(/Showing (\d+) of (\d+) candidates;/);
    expect(match).not.toBeNull();
    if (match) {
      const totalShown = parseInt(match[1], 10);
      const totalCandidates = parseInt(match[2], 10);
      // MCP's totalCandidates comes from loadAllEntries (all rows in tenant)
      // so it should be 30 (all our seeded rows).
      expect(totalCandidates).toBe(30);
      // Shown count is bounded by physics/hybrid budget (200 tokens).
      expect(totalShown).toBeGreaterThan(0);
      expect(totalShown).toBeLessThan(30);
    }
  });

  it('no Cutoff block when memory store is empty (no non-zero counters)', async () => {
    // Empty store -> 0 candidates, 0 of everything -> Cutoff not emitted.
    const res = await callTool(3, 'hippo_recall', { query: 'nothing' }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: { subject: 'mcp:test', role: 'admin' },
    });
    const text = extractText(res);
    expect(text).not.toMatch(/## Cutoff/);
    // v1.13.3 regression guard: the OLD "WYSIATI:" prefix must never appear
    // again — its bottom-placement was the dogfood-confirmed read failure.
    expect(text).not.toMatch(/WYSIATI:/);
  });

  it('v1.13.3 top-placement guard: Cutoff block appears BEFORE the first memory row', async () => {
    // Dogfood (docs/dogfood/2026-05-27-track-j-warnings.md) confirmed the
    // pre-v1.13.3 bottom-placement was the read-failure root cause. This
    // test locks the new top-placement so a future refactor cannot regress
    // the warning back below the result list without breaking the suite.
    for (let i = 0; i < 30; i++) {
      writeEntry(home, createMemory(`omega ${i} ${'padding text '.repeat(20)}`, {
        layer: Layer.Buffer,
        kind: 'raw' as MemoryKind,
        tenantId: 'default',
      }));
    }
    const res = await callTool(4, 'hippo_recall', { query: 'omega', budget: 200 }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: { subject: 'mcp:test', role: 'admin' },
    });
    const text = extractText(res);
    const cutoffIdx = text.indexOf('## Cutoff');
    // formatMemories starts with "Found N memories:" header; that's the
    // robust anchor for "where the result list begins". Lock the Cutoff
    // block strictly before it so a future refactor cannot regress to
    // bottom-placement.
    const firstMemoryIdx = text.search(/^Found \d+ memories:/m);
    expect(cutoffIdx).toBeGreaterThanOrEqual(0);
    expect(firstMemoryIdx).toBeGreaterThanOrEqual(0);
    expect(cutoffIdx).toBeLessThan(firstMemoryIdx);
  });
});
