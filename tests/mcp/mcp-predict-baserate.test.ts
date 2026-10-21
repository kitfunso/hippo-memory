/**
 * J3 baserate detector — MCP tool test.
 * Docs: docs/plans/2026-05-26-j3-baserate-detector.md
 *
 * Covers:
 * 1. hippo_predict_baserate tool returns text response for a class with data
 * 2. Empty class returns guidance text (not error)
 * 3. Missing class_tag returns clear usage message
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { handleMcpRequest, type McpContext, type McpResponse } from '../../src/surface/mcp/server.js';
import { savePrediction } from '../_helpers/save-prediction.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { closePrediction } from '../_helpers/root-forms.js';
import { loadConfig } from '../../src/base/config/config.js';
import { testInfra } from '../_helpers/infra.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

type ToolArgs = {
  class_tag?: string;
};

function callTool(reqId: number, name: string, args: ToolArgs, ctx: McpContext) {
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
  // SAFETY: a successful tools/call response always carries
  // result.content[0].text (src/surface/mcp/server.ts handleMcpRequest 'tools/call'
  // case constructs this exact shape).
  const result = res?.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? '';
}

describe('mcp hippo_predict_baserate', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot('mcp-j3');
    vi.stubEnv('HIPPO_HOME', home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns formatted text response for a class with closed predictions', async () => {
    // Seed 3 closed predictions
    const estimateActualPairs: Array<[number, number]> = [
      [2, 4],
      [3, 6],
      [1, 1],
    ];
    for (const [est, act] of estimateActualPairs) {
      const p = savePrediction(home, 'default', {
        classTag: 'mcp-test',
        claimText: `est ${est} act ${act}`,
        estimateValue: est,
      });
      closePrediction(home, 'default', p.id, { closureState: 'closed', actualValue: act });
    }

    const res = await callTool(
      1,
      'hippo_predict_baserate',
      { class_tag: 'mcp-test' },
      {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp:test',
        role: 'admin',
        hostAdmin: true,
        store: sqliteStore(home),
        config: loadConfig(home),
        infra: testInfra(),
      },
    );
    const text = extractText(res);

    // Summary line + stats block
    expect(text).toContain('Last 3 estimates');
    expect(text).toContain('mcp-test');
    expect(text).toMatch(/n_closed:\s+3/);
    expect(text).toMatch(/n_ratio_eligible:\s+3/);
    expect(text).toMatch(/mean_ratio:/);
    expect(text).toMatch(/p50_ratio:/);
    expect(text).toMatch(/mae:/);
  });

  it('empty class returns guidance text (not error)', async () => {
    const res = await callTool(
      2,
      'hippo_predict_baserate',
      { class_tag: 'never-seen' },
      {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp:test',
        role: 'admin',
        hostAdmin: true,
        store: sqliteStore(home),
        config: loadConfig(home),
        infra: testInfra(),
      },
    );
    const text = extractText(res);
    expect(text).toContain('No closed predictions');
    expect(text).toContain('never-seen');
    expect(text).toContain('hippo_predict');
  });

  it('missing class_tag is rejected as an invalid argument', async () => {
    const res = await callTool(
      3,
      'hippo_predict_baserate',
      {},
      {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp:test',
        role: 'admin',
        hostAdmin: true,
        store: sqliteStore(home),
        config: loadConfig(home),
        infra: testInfra(),
      },
    );
    expect(res?.result).toMatchObject({ isError: true });
    expect(extractText(res)).toContain('class_tag is required');
  });

  it('blank class_tag returns clear usage message', async () => {
    const res = await callTool(
      4,
      'hippo_predict_baserate',
      { class_tag: '  ' },
      {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp:test',
        role: 'admin',
        hostAdmin: true,
        store: sqliteStore(home),
        config: loadConfig(home),
        infra: testInfra(),
      },
    );
    const text = extractText(res);
    expect(text).toContain('No class_tag');
    expect(text).toContain('Usage');
  });
});
