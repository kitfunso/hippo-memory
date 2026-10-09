import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import { readEntry } from '../src/store/entry-reads.js';
import { saveActiveTaskSnapshot, appendSessionEvent } from '../src/store/sessions.js';
import { saveSessionHandoff } from '../src/store/handoffs.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { handleMcpRequest, type McpResponse } from '../src/mcp/server.js';
import { makeRoot } from './_helpers/make-root.js';

function callTool(
  reqId: number,
  name: string,
  args: Record<string, string | number | boolean>,
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

function extractText(res: McpResponse | null): string {
  // SAFETY: every hippo_context tool response in this suite carries a
  // single MCP text content block; the server's own formatter built it.
  const result = res?.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? '';
}

describe('mcp hippo_context scope filter', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot('mcp-context-scope');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('prints the snapshot, handoff and trail, and drops a superseded row', async () => {
    const current = createMemory('the deploy runbook lives in docs/deploy.md');
    const other = createMemory('rollbacks go through the release branch');
    const old = createMemory('the deploy runbook lives in the wiki');
    old.superseded_by = current.id;
    for (const e of [current, other, old]) writeEntry(home, e);
    saveActiveTaskSnapshot(home, 'default', { task: 'Parity snapshot task', summary: 'snapshot summary', next_step: 'snapshot next step', session_id: 'sess-ctx-text', source: 'test' });
    appendSessionEvent(home, 'default', { session_id: 'sess-ctx-text', event_type: 'note', content: 'parity trail event', source: 'test' });
    saveSessionHandoff(home, 'default', { version: 1, sessionId: 'sess-ctx-text', summary: 'parity handoff summary', nextAction: 'parity handoff next action' });

    // Outside git, so the auto query is empty and the text does not follow the host checkout.
    const cwd = process.cwd();
    process.chdir(home);
    try {
      const text = extractText(await callTool(5, 'hippo_context', { budget: 4000 }, { hippoRoot: home, tenantId: 'default', actor: 'mcp' }));
      expect(text).toContain('## Active Task Snapshot');
      expect(text).toContain('## Session Handoff');
      expect(text).toContain('parity handoff summary');
      expect(text).toContain('parity trail event');
      expect(text).toContain('Found 2 memories:');
      expect(text).not.toContain('lives in the wiki');
    } finally {
      process.chdir(cwd);
    }
  });

  it('budget=0 returns no context without marking memories retrieved', async () => {
    const memory = createMemory('zero budget canary memory');
    writeEntry(home, memory);
    saveActiveTaskSnapshot(home, 'default', {
      task: 'Zero budget snapshot',
      summary: 'Must not be returned',
      next_step: 'Stay hidden',
      session_id: 'sess-zero-budget',
      source: 'test',
    });

    const res = await callTool(0, 'hippo_context', { budget: 0 }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
    });

    expect(extractText(res)).toBe('Done.');
    expect(readEntry(home, memory.id)?.retrieval_count).toBe(0);
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

  it('v39 origin partition at the MCP surface: cross-project-origin rows do not inject', async () => {
    // Synced-down / legacy rows in the served store can carry another
    // project's origin; hippo_context must exclude them (same policy as
    // api.getContext). 'proj-b' can never equal the resolved identity of a
    // fresh tmpdir store, so this is deterministic.
    writeEntry(home, createMemory('own public deploykey fact'));
    writeEntry(home, {
      ...createMemory('BRAVO deploykey fact from another project', { pinned: true }),
      origin_project: 'proj-b',
    });

    const res = await callTool(3, 'hippo_context', {}, {
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
    });
    const text = extractText(res);
    expect(text).not.toContain('BRAVO deploykey fact from another project');
  });

  it('v39 secret veto at the MCP surface: secret rows never inject outside their owner', async () => {
    // Secret with a foreign origin AND secret with no origin: both denied
    // (ambientSecretAdmit admits a flagged row only inside its owning project).
    writeEntry(home, {
      ...createMemory('mcp secret sk_vendor_deadbeef123456 foreign', { pinned: true }),
      origin_project: 'proj-b',
    });
    writeEntry(home, {
      ...createMemory('mcp secret sk_vendor_feedface654321 orphan', { pinned: true }),
      origin_project: '',
    });

    const res = await callTool(4, 'hippo_context', {}, {
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
    });
    const text = extractText(res);
    expect(text).not.toContain('sk_vendor_deadbeef123456');
    expect(text).not.toContain('sk_vendor_feedface654321');
  });
});
