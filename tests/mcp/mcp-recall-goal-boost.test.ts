import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { remember } from '../../src/api/index.js';
import { handleMcpRequest, type McpContext, type McpResponse } from '../../src/surface/mcp/server.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { pushGoal } from '../_helpers/root-forms.js';
import { loadConfig } from '../../src/host/config-file.js';
import { removeDir } from '../_helpers/remove-dir.js';
import { testInfra } from '../_helpers/infra.js';
import { mcpContext } from '../_helpers/mcp-context.js';

type HippoRecallToolArgs = {
  query: string;
  budget?: number;
  session_id?: string;
};

function callTool(name: string, args: HippoRecallToolArgs, ctx: McpContext) {
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

function extractText(res: McpResponse | null): string {
  // SAFETY: hippo_recall's MCP tool result envelope always carries
  // result.content per src/surface/mcp/server.ts; McpResponse.result is typed
  // unknown at the transport layer since it varies per tool.
  return (res as { result?: { content: Array<{ text: string }> } } | null)?.result?.content?.[0]?.text ?? '';
}

function queryOne<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T | undefined {
  // SAFETY: sql is a literal SELECT against known hippo schema columns; the
  // row shape is declared by the generic type argument at each call site and
  // checked immediately by the assertions that follow.
  return db.prepare(sql).get(...params) as T | undefined;
}

describe('MCP hippo_recall session_id goal-stack boost', () => {
  let home: string;
  const tenantId = 'default';
  const sessionId = 'sess-mcp-1.7.4';

  beforeEach(() => {
    home = makeRoot('mcp-goal-boost');
  });

  afterEach(() => removeDir(home));

  it('session_id schema field is accepted (no validation error) and reaches the boost', async () => {
    const ctx: McpContext = mcpContext({
      hippoRoot: home,
      tenantId,
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      store: sqliteStore(home),
      config: loadConfig(home),
      infra: testInfra(),
    });
    await remember(apiCtx(home, tenantId, { subject: 'test', role: 'admin' }), {
      content: 'auth bug fix details',
      tags: ['fix-auth'],
    });
    await pushGoal(home, { sessionId, tenantId, goalName: 'fix-auth' });

    const res = await callTool('hippo_recall', { query: 'auth', budget: 2000, session_id: sessionId }, ctx);
    const text = extractText(res);
    expect(text).toContain('auth bug fix details');
    const db = openHippoDb(home);
    try {
      const count = queryOne<{ c: number }>(
        db,
        `SELECT COUNT(*) AS c FROM goal_recall_log WHERE session_id = ?`,
        sessionId,
      )!.c;
      expect(count).toBe(1);
    } finally {
      closeHippoDb(db);
    }
  });

  it('without session_id, no boost runs and goal_recall_log stays empty', async () => {
    const ctx: McpContext = mcpContext({
      hippoRoot: home,
      tenantId,
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      store: sqliteStore(home),
      config: loadConfig(home),
      infra: testInfra(),
    });
    await remember(apiCtx(home, tenantId, { subject: 'test', role: 'admin' }), {
      content: 'auth bug fix details',
      tags: ['fix-auth'],
    });
    await pushGoal(home, { sessionId, tenantId, goalName: 'fix-auth' });

    await callTool('hippo_recall', { query: 'auth', budget: 2000 }, ctx);

    const db = openHippoDb(home);
    try {
      const count = queryOne<{ c: number }>(
        db,
        `SELECT COUNT(*) AS c FROM goal_recall_log WHERE session_id = ?`,
        sessionId,
      )!.c;
      expect(count).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });
});
