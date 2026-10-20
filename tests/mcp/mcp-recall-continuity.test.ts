import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { handleMcpRequest, type McpResponse } from '../../src/surface/mcp/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadConfig } from '../../src/base/config/config.js';
import { writeEntry, saveActiveTaskSnapshot, appendSessionEvent, saveSessionHandoff } from '../_helpers/root-forms.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

afterEach(() => {
  vi.unstubAllEnvs();
});

type HippoRecallArgs = {
  query: string;
  include_continuity?: boolean;
  scope?: string;
};

function callTool(
  reqId: number,
  name: string,
  args: HippoRecallArgs,
  ctx: { hippoRoot: string; tenantId: string; actor: string; clientKey?: string },
) {
  return handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: reqId,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    { ...ctx, role: 'admin', hostAdmin: true, store: sqliteStore(ctx.hippoRoot), config: loadConfig(ctx.hippoRoot) },
  );
}

interface McpToolCallResult {
  content?: Array<{ text?: string }>;
}

function extractText(res: McpResponse | null): string {
  if (res === null || res.result === undefined) return '';
  // SAFETY: every call in this file dispatches method 'tools/call', whose
  // result shape is always `{ content: [{ type: 'text', text }] }` per the
  // 'tools/call' branch of handleMcpRequest (src/surface/mcp/server.ts).
  const result = res.result as McpToolCallResult;
  return result.content?.[0]?.text ?? '';
}

describe('mcp hippo_recall include_continuity', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot('mcp-recall-cont');
    vi.stubEnv('HIPPO_HOME', home);
  });

  afterEach(() => {
    removeAfterRequest(home);
  });

  it('omits continuity by default (hot path)', async () => {
    writeEntry(home, createMemory('memory about deploys', {}));
    const res = await callTool(
      1,
      'hippo_recall',
      { query: 'deploys' },
      {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp',
      },
    );
    const text = extractText(res);
    expect(text).not.toContain('## Continuity');
  });

  it('appends continuity text section when include_continuity=true', async () => {
    writeEntry(home, createMemory('memory about deploys', {}));
    saveActiveTaskSnapshot(home, 'default', {
      task: 'Wire MCP continuity',
      summary: 'Plan reviewed.',
      next_step: 'Land Task 2.',
      session_id: 'sess-mcp-1',
      source: 'test',
    });
    saveSessionHandoff(home, 'default', {
      version: 1,
      sessionId: 'sess-mcp-1',
      summary: 'Mid-task.',
      nextAction: 'Resume on commit.',
      artifacts: [],
    });
    appendSessionEvent(home, 'default', {
      session_id: 'sess-mcp-1',
      event_type: 'note',
      content: 'A trail event.',
      source: 'test',
    });

    const res = await callTool(
      2,
      'hippo_recall',
      {
        query: 'deploys',
        include_continuity: true,
      },
      {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp',
      },
    );
    const text = extractText(res);
    expect(text).toContain('## Continuity');
    expect(text).toContain('Wire MCP continuity');
    expect(text).toContain('Resume on commit.');
    expect(text).toContain('A trail event.');
  });

  it('default-deny rejects private-scope continuity for no-scope MCP caller', async () => {
    writeEntry(home, createMemory('memory about deploys', {}));
    saveActiveTaskSnapshot(home, 'default', {
      task: 'Private task',
      summary: 'Private',
      next_step: 'Private',
      session_id: 'sess-private',
      source: 'test',
      scope: 'slack:private:Csecret',
    });

    const res = await callTool(
      3,
      'hippo_recall',
      {
        query: 'deploys',
        include_continuity: true,
      },
      {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp',
      },
    );
    const text = extractText(res);
    expect(text).toContain('## Continuity');
    expect(text).not.toContain('Private task');
  });

  it('explicit scope DOES surface matching private continuity', async () => {
    writeEntry(home, createMemory('memory about deploys', {}));
    saveActiveTaskSnapshot(home, 'default', {
      task: 'Private task',
      summary: 'Private',
      next_step: 'Private',
      session_id: 'sess-private',
      source: 'test',
      scope: 'slack:private:Csecret',
    });

    const res = await callTool(
      4,
      'hippo_recall',
      {
        query: 'deploys',
        include_continuity: true,
        scope: 'slack:private:Csecret',
      },
      {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp',
      },
    );
    const text = extractText(res);
    expect(text).toContain('Private task');
  });
});
