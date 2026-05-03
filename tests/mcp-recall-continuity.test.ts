import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initStore,
  saveActiveTaskSnapshot,
  saveSessionHandoff,
  appendSessionEvent,
  writeEntry,
} from '../src/store.js';
import { createMemory } from '../src/memory.js';
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
  ctx: { hippoRoot: string; tenantId: string; actor: string; clientKey?: string },
) {
  return handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: reqId,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    ctx,
  );
}

function extractText(res: unknown): string {
  const r = res as { result?: { content?: Array<{ text?: string }> } } | null;
  return r?.result?.content?.[0]?.text ?? '';
}

describe('mcp hippo_recall include_continuity', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = makeRoot('mcp-recall-cont');
    originalHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = originalHome;
  });

  it('omits continuity by default (hot path)', async () => {
    writeEntry(home, createMemory('memory about deploys', {}));
    const res = await callTool(1, 'hippo_recall', { query: 'deploys' }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
    });
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

    const res = await callTool(2, 'hippo_recall', {
      query: 'deploys',
      include_continuity: true,
    }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
    });
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

    const res = await callTool(3, 'hippo_recall', {
      query: 'deploys',
      include_continuity: true,
    }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
    });
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

    const res = await callTool(4, 'hippo_recall', {
      query: 'deploys',
      include_continuity: true,
      scope: 'slack:private:Csecret',
    }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
    });
    const text = extractText(res);
    expect(text).toContain('Private task');
  });
});
