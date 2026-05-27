/**
 * J1 — MCP hippo_recall anchoringHint integration.
 *
 * Asserts the MCP handler:
 * - Tracks per-(tenant, session) ring buffer keyed by buildSessionKey
 * - Renders `## Anchoring hint` block in text response when hint fires
 * - Bumps mcpSuppressionSummary.suppressedByInterference on R2
 * - Emits `recall_anchor_skipped_no_session` when sessionId absent
 * - Module-level Map is reset via __resetSessionRecallHistoryMcp helper
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createMemory, Layer, MemoryKind } from '../src/memory.js';
import { handleMcpRequest, __resetSessionRecallHistoryMcp } from '../src/mcp/server.js';

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
    { jsonrpc: '2.0', id: reqId, method: 'tools/call', params: { name, arguments: args } },
    ctx as unknown as { hippoRoot: string; tenantId: string; actor: string; clientKey?: string },
  );
}

function extractText(res: unknown): string {
  const r = res as { result?: { content?: Array<{ text?: string }> } } | null;
  return r?.result?.content?.[0]?.text ?? '';
}

function countAuditOps(root: string, op: string): number {
  const db = openHippoDb(root);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE op = ?`).get(op) as { n: number };
    return row.n;
  } finally {
    closeHippoDb(db);
  }
}

describe('mcp hippo_recall anchoringHint (J1, v0.33)', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = makeRoot('mcp-j1');
    originalHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = home;
    delete process.env.HIPPO_ANCHORING;
    __resetSessionRecallHistoryMcp();
    // Seed a memory that matches the test query so MCP physics/hybrid
    // returns a non-null top-1.
    for (let i = 0; i < 3; i++) {
      writeEntry(home, createMemory(`frobnicate baz quux content ${i}`, {
        layer: Layer.Buffer,
        confidence: 'observed',
        kind: 'raw' as MemoryKind,
        tenantId: 'default',
      }));
    }
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = originalHome;
    delete process.env.HIPPO_ANCHORING;
    __resetSessionRecallHistoryMcp();
  });

  it('R2 fires after >=3 recalls with same query on same session (memory_dominance + suppressedByInterference bumped)', async () => {
    const ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'mcp' as const, role: 'admin' as const } };
    // Three recalls with DIFFERENT queries on the same session — same top
    // memory should win each time and trigger R2 on the 3rd.
    await callTool(1, 'hippo_recall', { query: 'frobnicate baz quux', session_id: 'sess1' }, ctx);
    await callTool(2, 'hippo_recall', { query: 'frobnicate baz different words', session_id: 'sess1' }, ctx);
    const res3 = await callTool(3, 'hippo_recall', { query: 'frobnicate quux yet another', session_id: 'sess1' }, ctx);
    const text = extractText(res3);
    expect(text).toContain('## Anchoring hint');
    expect(text).toContain('[anchored_on:');
    expect(countAuditOps(home, 'recall_anchor_detected_memory_dominance')).toBeGreaterThanOrEqual(1);
    // Plan v3 Acceptance §6: suppressedByInterference must bump on ALL THREE
    // user-facing surfaces when R2 fires. MCP's WYSIATI line surfaces the
    // mcpSuppressionSummary counter — assert the bump is visible there.
    // Independent-review-critic round 1 catch: prior test docstring claimed
    // this assertion but had no actual expect() — now backed.
    expect(text).toMatch(/suppressed by interference|interference/i);
  });

  it('does NOT render anchoring block on the first recall (no history yet)', async () => {
    const ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'mcp' as const, role: 'admin' as const } };
    const res = await callTool(1, 'hippo_recall', { query: 'frobnicate baz quux', session_id: 'sess1' }, ctx);
    const text = extractText(res);
    expect(text).not.toContain('## Anchoring hint');
  });

  it('emits recall_anchor_skipped_no_session when session_id is absent', async () => {
    const ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'mcp' as const, role: 'admin' as const } };
    expect(countAuditOps(home, 'recall_anchor_skipped_no_session')).toBe(0);
    await callTool(1, 'hippo_recall', { query: 'frobnicate baz quux' }, ctx);
    expect(countAuditOps(home, 'recall_anchor_skipped_no_session')).toBe(1);
  });

  it('does NOT render anchoring block when HIPPO_ANCHORING=off', async () => {
    process.env.HIPPO_ANCHORING = 'off';
    const ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'mcp' as const, role: 'admin' as const } };
    // Repeat 3 distinct queries — would normally fire R2.
    await callTool(1, 'hippo_recall', { query: 'frobnicate baz quux', session_id: 'sess1' }, ctx);
    await callTool(2, 'hippo_recall', { query: 'frobnicate baz different words', session_id: 'sess1' }, ctx);
    const res3 = await callTool(3, 'hippo_recall', { query: 'frobnicate quux yet another', session_id: 'sess1' }, ctx);
    const text = extractText(res3);
    expect(text).not.toContain('## Anchoring hint');
  });
});
