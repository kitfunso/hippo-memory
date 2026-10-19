// Pins each MCP read tool's text over one fixed store, through the stdio composition root, so moving the render into
// src/api cannot change a byte of what a client reads.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { handleMcpRequest, type McpResponse } from '../../src/mcp/server.js';
import { cliStdioHost } from '../../src/cli/api-context.js';
import type { McpHost } from '../../src/mcp/protocol.js';
import {
  CLEARED_ENV,
  FAKE_NOW,
  freshStore,
  normalize,
  seedPortBranches,
  seedTemplates,
  SESSION,
  TENANT,
  type Store,
  type Templates,
} from '../_helpers/recall-golden-seed.js';

type ToolArgs = Record<string, string | number | boolean>;

// One host per store, as one stdio loop serves one client: an outcome lands on what that host's recall showed.
let host: McpHost;

let templates: Templates;

// A named project keeps hippo_context off the git-derived query, which would read this checkout's own diff.
const NO_PROJECT = { name: '', legacyName: '' };

async function tool(s: Store, name: string, args: ToolArgs): Promise<string> {
  const res: McpResponse | null = await handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { ...host.contextFor(s.root, TENANT), project: NO_PROJECT },
  );
  // SAFETY: a tools/call result is written by src/mcp/request.ts as { content: [{ text }], isError? }.
  const result = res?.result as { content?: { text: string }[] } | undefined;
  return result?.content?.[0]?.text ?? JSON.stringify(res?.error);
}

async function onFreshStore(run: (s: Store) => Promise<string[]>): Promise<string[]> {
  const s = freshStore(templates, 'local');
  host = cliStdioHost();
  try {
    return normalize(await run(s), s);
  } finally {
    rmSync(s.home, { recursive: true, force: true });
  }
}

// Seeds three real template stores, and a runner's disk sets how long that takes.
beforeAll(async () => {
  templates = await seedTemplates(seedPortBranches);
}, 30_000);

afterAll(() => {
  rmSync(templates.dir, { recursive: true, force: true });
});

describe('MCP read tools golden', () => {
  beforeEach(() => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hippo_recall: a plain query, then hippo_outcome on the ids it showed', async () => {
    const got = await onFreshStore(async (s) => [
      await tool(s, 'hippo_recall', { query: 'deploy' }),
      await tool(s, 'hippo_outcome', { good: true }),
    ]);
    expect(got).toMatchSnapshot();
  });

  it('hippo_recall: repeats in one session raise the anchoring hint', async () => {
    const got = await onFreshStore(async (s) => {
      const out: string[] = [];
      for (const query of ['deploy', 'deploy', 'deploy target']) {
        out.push(await tool(s, 'hippo_recall', { query, session_id: SESSION }));
      }
      return out;
    });
    expect(got).toMatchSnapshot();
  });

  it('hippo_recall: a tight budget with continuity and a fresh tail prints the Cutoff block', async () => {
    const got = await onFreshStore(async (s) => [
      await tool(s, 'hippo_recall', {
        query: 'deploy',
        budget: 300,
        include_continuity: true,
        fresh_tail_count: 2,
        fresh_tail_session_id: SESSION,
        session_id: SESSION,
      }),
      await tool(s, 'hippo_recall', { query: 'the deploy will take 3 days', budget: 600 }),
    ]);
    expect(got).toMatchSnapshot();
  });

  it('hippo_context, hippo_assemble and hippo_drill', async () => {
    const got = await onFreshStore(async (s) => [
      await tool(s, 'hippo_context', { budget: 400 }),
      await tool(s, 'hippo_assemble', { session_id: SESSION, budget: 400 }),
      await tool(s, 'hippo_drill', { summary_id: 'mem_x_summary' }),
    ]);
    expect(got).toMatchSnapshot();
  });
});
