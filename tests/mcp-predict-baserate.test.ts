/**
 * J3 baserate detector — MCP tool test.
 * Docs: docs/plans/2026-05-26-j3-baserate-detector.md
 *
 * Covers:
 * 1. hippo_predict_baserate tool returns text response for a class with data
 * 2. Empty class returns guidance text (not error)
 * 3. Missing class_tag returns clear usage message
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { savePrediction, closePrediction } from '../src/predictions.js';

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
  ctx: { hippoRoot: string; tenantId: string; actor: { subject: string; role: 'admin' | 'member' }; clientKey?: string },
) {
  return handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: reqId,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    ctx as unknown as { hippoRoot: string; tenantId: string; actor: string; clientKey?: string },
  );
}

function extractText(res: unknown): string {
  const r = res as { result?: { content?: Array<{ text?: string }> } } | null;
  return r?.result?.content?.[0]?.text ?? '';
}

describe('mcp hippo_predict_baserate (J3, v0.31)', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = makeRoot('mcp-j3');
    originalHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = originalHome;
  });

  it('returns formatted text response for a class with closed predictions', async () => {
    // Seed 3 closed predictions
    for (const [est, act] of [[2, 4], [3, 6], [1, 1]] as Array<[number, number]>) {
      const p = savePrediction(home, 'default', {
        classTag: 'mcp-test',
        claimText: `est ${est} act ${act}`,
        estimateValue: est,
      });
      closePrediction(home, 'default', p.id, { closureState: 'closed', actualValue: act });
    }

    const res = await callTool(1, 'hippo_predict_baserate', { class_tag: 'mcp-test' }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: { subject: 'mcp:test', role: 'admin' },
    });
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
    const res = await callTool(2, 'hippo_predict_baserate', { class_tag: 'never-seen' }, {
      hippoRoot: home,
      tenantId: 'default',
      actor: { subject: 'mcp:test', role: 'admin' },
    });
    const text = extractText(res);
    expect(text).toContain('No closed predictions');
    expect(text).toContain('never-seen');
    expect(text).toContain('hippo_predict');
  });

  it('missing class_tag returns clear usage message', async () => {
    const res = await callTool(3, 'hippo_predict_baserate', {}, {
      hippoRoot: home,
      tenantId: 'default',
      actor: { subject: 'mcp:test', role: 'admin' },
    });
    const text = extractText(res);
    expect(text).toContain('No class_tag');
    expect(text).toContain('Usage');
  });
});
