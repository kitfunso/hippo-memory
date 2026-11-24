import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleMcpRequest, type McpContext, type McpResponse } from '../../src/surface/mcp/server.js';
import { savePrediction } from '../_helpers/save-prediction.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { closePrediction } from '../_helpers/root-forms.js';
import { cliConfig } from '../../src/surface/cli/api-context.js';
import { removeDir } from '../_helpers/remove-dir.js';
import { testInfra } from '../_helpers/infra.js';
import { mcpContext } from '../_helpers/mcp-context.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

type HippoRecallToolArgs = {
  query: string;
};

function callTool(reqId: number, name: string, args: HippoRecallToolArgs, ctx: McpContext) {
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
  // SAFETY: hippo_recall's MCP tool result envelope always carries
  // result.content per src/surface/mcp/server.ts; McpResponse.result is typed
  // unknown at the transport layer since it varies per tool.
  const r = res as { result?: { content?: Array<{ text?: string }> } } | null;
  return r?.result?.content?.[0]?.text ?? '';
}

async function seedBaserate(home: string): Promise<void> {
  const estimateVsActual: Array<[number, number]> = [
    [2, 4],
    [3, 6],
    [4, 8],
  ];
  for (const [est, act] of estimateVsActual) {
    const p = await savePrediction(home, 'default', {
      classTag: 'migration-effort',
      claimText: `migration effort ${est} days`,
      estimateValue: est,
    });
    await closePrediction(home, 'default', p.id, { closureState: 'closed', actualValue: act });
  }
}

describe('mcp hippo_recall planningFallacyHint text block', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot('mcp-j32');
    vi.stubEnv('HIPPO_HOME', home);
    vi.stubEnv('HIPPO_AUTODEBIAS', undefined);
  });

  afterEach(() => {
    removeDir(home);
  });

  it('prepends "## Planning fallacy hint" block when query matches forward-claim AND class resolves', async () => {
    await seedBaserate(home);
    const ctx: McpContext = mcpContext({
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      store: sqliteStore(home),
      config: cliConfig(home),
      infra: testInfra(),
    });
    const res = await callTool(1, 'hippo_recall', { query: 'migration effort will take 3 days' }, ctx);
    const text = extractText(res);
    expect(text).toContain('## Planning fallacy hint');
    expect(text).toContain('migration-effort');
    expect(text).toContain('Class: migration-effort');
    expect(text.toLowerCase()).toContain('detected:');
  });

  it('does NOT prepend the hint block when query has no forward-claim phrase', async () => {
    await seedBaserate(home);
    const ctx: McpContext = mcpContext({
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      store: sqliteStore(home),
      config: cliConfig(home),
      infra: testInfra(),
    });
    const res = await callTool(1, 'hippo_recall', { query: 'show me the auth flow' }, ctx);
    const text = extractText(res);
    expect(text).not.toContain('## Planning fallacy hint');
  });

  it('does NOT prepend the hint block when HIPPO_AUTODEBIAS=off', async () => {
    await seedBaserate(home);
    vi.stubEnv('HIPPO_AUTODEBIAS', 'off');
    const ctx: McpContext = mcpContext({
      hippoRoot: home,
      tenantId: 'default',
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      store: sqliteStore(home),
      config: cliConfig(home),
      infra: testInfra(),
    });
    const res = await callTool(1, 'hippo_recall', { query: 'migration effort will take 3 days' }, ctx);
    const text = extractText(res);
    expect(text).not.toContain('## Planning fallacy hint');
  });
});
