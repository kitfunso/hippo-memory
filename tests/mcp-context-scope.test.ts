import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, saveActiveTaskSnapshot, writeEntry } from '../src/store.js';
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

describe('mcp hippo_context scope filter', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot('mcp-context-scope');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('default-deny: no-scope caller does not see private-scope memories or snapshot', async () => {
    writeEntry(home, createMemory('public memory about the project', { scope: 'slack:public:Cgeneral' }));
    writeEntry(home, createMemory('private memory secret', { scope: 'slack:private:Csecret' }));
    saveActiveTaskSnapshot(home, 'default', {
      task: 'Private task that must not leak',
      summary: 'Private',
      next_step: 'Private',
      session_id: 'sess-private',
      source: 'test',
      scope: 'slack:private:Csecret',
    });

    const res = await callTool(1, 'hippo_context', {}, {
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
    });
    const text = extractText(res);
    expect(text).not.toContain('private memory secret');
    expect(text).not.toContain('Private task that must not leak');
  });

  it('explicit scope match returns the matching private snapshot and memory', async () => {
    writeEntry(home, createMemory('private memory secret', { scope: 'slack:private:Csecret' }));
    saveActiveTaskSnapshot(home, 'default', {
      task: 'Private task',
      summary: 'Private',
      next_step: 'Private',
      session_id: 'sess-private',
      source: 'test',
      scope: 'slack:private:Csecret',
    });

    const res = await callTool(2, 'hippo_context', { scope: 'slack:private:Csecret' }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
    });
    const text = extractText(res);
    expect(text).toContain('Private task');
  });
});
