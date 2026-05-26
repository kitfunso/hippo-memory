/**
 * J3.2 — MCP hippo_recall planning-fallacy hint text block.
 *
 * Asserts the MCP handler prepends a "## Planning fallacy hint" block to
 * the response text when the query carries a forward-claim phrase AND a
 * class resolves. Reads from apiResult.planningFallacyHint (single source
 * of truth — NOT recomputed, since the value is pipeline-invariant; only
 * one audit row fires per recall).
 *
 * Plan: docs/plans/2026-05-26-j32-auto-injection.md (Task 7, Task 9).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { savePrediction, closePrediction } from '../src/predictions.js';

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

function seedBaserate(home: string): void {
  for (const [est, act] of [[2, 4], [3, 6], [4, 8]] as Array<[number, number]>) {
    const p = savePrediction(home, 'default', {
      classTag: 'migration-effort',
      claimText: `migration effort ${est} days`,
      estimateValue: est,
    });
    closePrediction(home, 'default', p.id, { closureState: 'closed', actualValue: act });
  }
}

describe('mcp hippo_recall planningFallacyHint text block (J3.2 v0.32)', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = makeRoot('mcp-j32');
    originalHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = home;
    delete process.env.HIPPO_AUTODEBIAS;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = originalHome;
    delete process.env.HIPPO_AUTODEBIAS;
  });

  it('prepends "## Planning fallacy hint" block when query matches forward-claim AND class resolves', async () => {
    seedBaserate(home);
    const ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'mcp' as const, role: 'admin' as const } };
    const res = await callTool(1, 'hippo_recall', { query: 'migration effort will take 3 days' }, ctx);
    const text = extractText(res);
    expect(text).toContain('## Planning fallacy hint');
    expect(text).toContain('migration-effort');
    expect(text).toContain('Class: migration-effort');
    // detectedPhrase wrapped in JSON.stringify quotes for render safety.
    expect(text.toLowerCase()).toContain('detected:');
  });

  it('does NOT prepend the hint block when query has no forward-claim phrase', async () => {
    seedBaserate(home);
    const ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'mcp' as const, role: 'admin' as const } };
    const res = await callTool(1, 'hippo_recall', { query: 'show me the auth flow' }, ctx);
    const text = extractText(res);
    expect(text).not.toContain('## Planning fallacy hint');
  });

  it('does NOT prepend the hint block when HIPPO_AUTODEBIAS=off', async () => {
    seedBaserate(home);
    process.env.HIPPO_AUTODEBIAS = 'off';
    const ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'mcp' as const, role: 'admin' as const } };
    const res = await callTool(1, 'hippo_recall', { query: 'migration effort will take 3 days' }, ctx);
    const text = extractText(res);
    expect(text).not.toContain('## Planning fallacy hint');
  });
});
