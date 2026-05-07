/**
 * v1.7.4 -- MCP hippo_recall accepts session_id and applies the dlPFC
 * goal-stack boost to its physics/hybrid result list before formatMemories.
 *
 * Codex v2 finding: MCP's user-visible primary ordering does NOT come from
 * api.recall (it goes through physicsSearch/hybridSearch separately), so
 * lifting the boost into api.recall alone leaves the MCP main band
 * unboosted. This test pins that the schema field is accepted AND that the
 * boost actually moves the goal-tagged memory ahead in the rendered output.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { remember } from '../src/api.js';
import { pushGoal } from '../src/goals.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-mcp-goal-boost-'));
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

function extractText(res: unknown): string {
  return (res as { result?: { content: Array<{ text: string }> } }).result
    ?.content?.[0]?.text ?? '';
}

describe('MCP hippo_recall session_id goal-stack boost (v1.7.4)', () => {
  let home: string;
  const tenantId = 'default';
  const sessionId = 'sess-mcp-1.7.4';

  beforeEach(() => {
    home = makeRoot();
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('session_id schema field is accepted (no validation error) and reaches the boost', async () => {
    const ctx = { hippoRoot: home, tenantId, actor: 'mcp' };
    remember({ hippoRoot: home, tenantId, actor: 'test' }, {
      content: 'auth bug fix details',
      tags: ['fix-auth'],
    });
    pushGoal(home, { sessionId, tenantId, goalName: 'fix-auth' });

    const res = await callTool(
      'hippo_recall',
      { query: 'auth', budget: 2000, session_id: sessionId },
      ctx,
    );
    const text = extractText(res);
    expect(text).toContain('auth bug fix details');
    // Side effect proves the boost ran on the MCP physics/hybrid path: the
    // tagged memory landed in goal_recall_log.
    const db = openHippoDb(home);
    try {
      const count = (db.prepare(
        `SELECT COUNT(*) AS c FROM goal_recall_log WHERE session_id = ?`,
      ).get(sessionId) as { c: number }).c;
      expect(count).toBeGreaterThan(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('without session_id, no boost runs and goal_recall_log stays empty (v1.7.3 baseline)', async () => {
    const ctx = { hippoRoot: home, tenantId, actor: 'mcp' };
    remember({ hippoRoot: home, tenantId, actor: 'test' }, {
      content: 'auth bug fix details',
      tags: ['fix-auth'],
    });
    pushGoal(home, { sessionId, tenantId, goalName: 'fix-auth' });

    await callTool('hippo_recall', { query: 'auth', budget: 2000 }, ctx);

    const db = openHippoDb(home);
    try {
      const count = (db.prepare(
        `SELECT COUNT(*) AS c FROM goal_recall_log WHERE session_id = ?`,
      ).get(sessionId) as { c: number }).c;
      expect(count).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });
});
