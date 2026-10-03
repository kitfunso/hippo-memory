import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  initStore,
  writeEntry,
  loadIndex,
  saveActiveTaskSnapshot,
  saveSessionHandoff,
  appendSessionEvent,
} from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { getContext, adminActor } from '../src/api.js';
import { autoDetectContext } from '../src/context-auto.js';
import { resolveProjectIdentity } from '../src/project-identity.js';
import { handleMcpRequest, type McpResponse } from '../src/mcp/server.js';

const SESSION = 'sess-mcp-parity';
const BUDGET = 4000;

function textOf(res: McpResponse | null): string {
  // SAFETY: hippo_context answers with one MCP text content block.
  const result = res?.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? '';
}

describe('MCP hippo_context returns what api.getContext returns', () => {
  let tmp: string;
  let root: string;
  let cwd: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hippo-mcp-context-parity-'));
    root = join(tmp, '.hippo');
    initStore(root);
    cwd = process.cwd();
    process.chdir(tmp); // outside git, so both callers get the same empty auto query
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  function seed() {
    const current = createMemory('the deploy runbook lives in docs/deploy.md');
    const other = createMemory('rollbacks go through the release branch');
    const old = createMemory('the deploy runbook lives in the wiki');
    old.superseded_by = current.id;
    for (const e of [current, other, old]) writeEntry(root, e);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'Parity snapshot task',
      summary: 'snapshot summary',
      next_step: 'snapshot next step',
      session_id: SESSION,
      source: 'test',
    });
    appendSessionEvent(root, 'default', {
      session_id: SESSION,
      event_type: 'note',
      content: 'parity trail event',
      source: 'test',
    });
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: SESSION,
      summary: 'parity handoff summary',
      nextAction: 'parity handoff next action',
    });
    return { kept: [current.id, other.id], superseded: old.id };
  }

  it('selects the same memory ids, prints the handoff and trail, and drops the superseded row', async () => {
    const { kept, superseded } = seed();

    const res = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_context', arguments: { budget: BUDGET } } },
      { hippoRoot: root, tenantId: 'default', actor: 'mcp' },
    );
    const text = textOf(res);
    const mcpIds = [...loadIndex(root).last_retrieval_ids].sort();

    const storeProject = resolveProjectIdentity(dirname(resolve(root))).name;
    const api = await getContext(
      { hippoRoot: root, tenantId: 'default', actor: adminActor('mcp') },
      {
        q: autoDetectContext(),
        budget: BUDGET,
        currentProject: storeProject !== '' ? storeProject : resolveProjectIdentity(process.cwd()).name,
      },
    );
    const apiIds = api.entries.map((r) => r.entry.id).sort();

    expect(mcpIds).toEqual([...kept].sort());
    expect(apiIds).toEqual(mcpIds);
    expect(text).toContain('## Active Task Snapshot');
    expect(text).toContain('## Session Handoff');
    expect(text).toContain('parity handoff summary');
    expect(text).toContain('parity trail event');
    expect(text).toContain('Found 2 memories:');
    expect(text).not.toContain('lives in the wiki');
    expect(mcpIds).not.toContain(superseded);
  });
});
