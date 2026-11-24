import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { Layer } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { handleMcpRequest, type McpContext, type McpResponse } from '../../src/surface/mcp/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { cliConfig } from '../../src/surface/cli/api-context.js';
import { createCallerState } from '../../src/api/callers.js';
import { testInfra } from '../_helpers/infra.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';
import { mcpContext } from '../_helpers/mcp-context.js';

afterEach(() => {
  vi.unstubAllEnvs();
});
const { writeEntry, sqliteStore } = sessionPerTest();

type RecallToolArgs = {
  query: string;
  session_id?: string;
};

function callTool(reqId: number, name: string, args: RecallToolArgs, ctx: McpContext) {
  return handleMcpRequest({ jsonrpc: '2.0', id: reqId, method: 'tools/call', params: { name, arguments: args } }, ctx);
}

function extractText(res: McpResponse | null): string {
  // SAFETY: handleMcpRequest's 'tools/call' case always wraps tool output in
  // MCP's { content: [{ type: 'text', text }] } shape (src/surface/mcp/server.ts);
  // McpResponse.result is `unknown` only because different tools return
  // different payloads.
  const r = res?.result as { content?: Array<{ text?: string }> } | undefined;
  return r?.content?.[0]?.text ?? '';
}

function countAuditOps(root: string, op: string): number {
  const db = openHippoDb(root);
  try {
    // SAFETY: COUNT(*) always returns exactly one row shaped { n: number };
    // better-sqlite3's .get() types as `unknown` with no query-shape knowledge.
    const row = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE op = ?`).get(op) as { n: number };
    return row.n;
  } finally {
    closeHippoDb(db);
  }
}

describe('mcp hippo_recall anchoringHint', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot('mcp-j1');
    vi.stubEnv('HIPPO_HOME', home);
    vi.stubEnv('HIPPO_ANCHORING', undefined);
    for (let i = 0; i < 3; i++) {
      writeEntry(
        home,
        createMemory(`frobnicate baz quux content ${i}`, {
          layer: Layer.Buffer,
          confidence: 'observed',
          kind: 'raw',
          tenantId: 'default',
        }),
      );
    }
  });

  it('R2 fires after >=3 recalls with same query on same session (memory_dominance + suppressedByInterference bumped)', async () => {
    const ctx: McpContext = mcpContext({
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      store: sqliteStore(home),
      config: cliConfig(home),
      infra: testInfra(),
      callers: createCallerState(),
    });
    await callTool(1, 'hippo_recall', { query: 'frobnicate baz quux', session_id: 'sess1' }, ctx);
    await callTool(2, 'hippo_recall', { query: 'frobnicate baz different words', session_id: 'sess1' }, ctx);
    const res3 = await callTool(3, 'hippo_recall', { query: 'frobnicate quux yet another', session_id: 'sess1' }, ctx);
    const text = extractText(res3);
    expect(text).toContain('## Anchoring hint');
    expect(text).toContain('[anchored_on:');
    expect(countAuditOps(home, 'recall_anchor_detected_memory_dominance')).toBeGreaterThanOrEqual(1);
    expect(text).toMatch(/suppressed by interference|interference/i);
  });

  it('does NOT render anchoring block on the first recall (no history yet)', async () => {
    const ctx: McpContext = mcpContext({
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      store: sqliteStore(home),
      config: cliConfig(home),
      infra: testInfra(),
      callers: createCallerState(),
    });
    const res = await callTool(1, 'hippo_recall', { query: 'frobnicate baz quux', session_id: 'sess1' }, ctx);
    const text = extractText(res);
    expect(text).not.toContain('## Anchoring hint');
  });

  it('emits recall_anchor_skipped_no_session when session_id is absent', async () => {
    const ctx: McpContext = mcpContext({
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      store: sqliteStore(home),
      config: cliConfig(home),
      infra: testInfra(),
      callers: createCallerState(),
    });
    expect(countAuditOps(home, 'recall_anchor_skipped_no_session')).toBe(0);
    await callTool(1, 'hippo_recall', { query: 'frobnicate baz quux' }, ctx);
    expect(countAuditOps(home, 'recall_anchor_skipped_no_session')).toBe(1);
  });

  it('does NOT render anchoring block when HIPPO_ANCHORING=off', async () => {
    vi.stubEnv('HIPPO_ANCHORING', 'off');
    const ctx: McpContext = mcpContext({
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      store: sqliteStore(home),
      config: cliConfig(home),
      infra: testInfra(),
      callers: createCallerState(),
    });
    await callTool(1, 'hippo_recall', { query: 'frobnicate baz quux', session_id: 'sess1' }, ctx);
    await callTool(2, 'hippo_recall', { query: 'frobnicate baz different words', session_id: 'sess1' }, ctx);
    const res3 = await callTool(3, 'hippo_recall', { query: 'frobnicate quux yet another', session_id: 'sess1' }, ctx);
    const text = extractText(res3);
    expect(text).not.toContain('## Anchoring hint');
  });
});
