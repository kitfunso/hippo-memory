// Pins each MCP tool's reply text on a seeded store, including the early-return and refusal lines, so the per-tool dispatch cannot drift.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { handleMcpRequest, type McpContext, type McpResponse } from '../src/mcp/server.js';

type Wire = string | number | boolean | null | Wire[] | { [key: string]: Wire };

let home: string;
let root: string;
let ctx: McpContext;

function text(res: McpResponse | null): string {
  // SAFETY: a tools/call reply is either a JSON-RPC error or a result with text content blocks.
  const r = res as { error?: { message: string }; result?: { isError?: boolean; content?: Array<{ text?: string }> } } | null;
  if (r?.error) return `error: ${r.error.message}`;
  const body = r?.result?.content?.[0]?.text ?? '';
  return r?.result?.isError ? `isError: ${body}` : body;
}

async function call(name: string, args: Wire = {}): Promise<string> {
  return text(await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx));
}

/** A tool that throws reaches the transport raw, so the thrown message is part of the contract too. */
async function settle(name: string, args: Wire): Promise<string> {
  try {
    return await call(name, args);
  } catch (err) {
    return `throws: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Generated ids vary per run; everything around them is the contract. */
function masked(s: string): string {
  return s.replace(/\b[a-z]+_[0-9a-f]{12}\b/g, '<id>');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hippo-mcp-tool-text-'));
  root = join(home, '.hippo');
  initStore(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ autoSleep: { enabled: false } }), 'utf8');
  vi.stubEnv('HIPPO_HOME', join(home, 'global'));
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  ctx = { hippoRoot: root, tenantId: 'default', actor: 'tester', clientKey: 'client-1' };
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('MCP tool reply text', () => {
  it('remember, recall, outcome, context and status', async () => {
    expect(masked(await call('hippo_remember', { text: '' }))).toMatchInlineSnapshot(`"No text provided."`);
    expect(masked(await call('hippo_remember', { text: 'the staging lock table blocks deploys', error: true, tag: 'deploy' }))).toMatchInlineSnapshot(`"Remembered [<id>] (half-life: 730d, tags: error, deploy)"`);
    expect(masked(await call('hippo_remember', { text: 'release notes are folded from changelog fragments' }))).toMatchInlineSnapshot(`"Remembered [<id>] (half-life: 365d, tags: none)"`);

    expect(await call('hippo_outcome', { good: true })).toMatchInlineSnapshot(`"No recent recalls to apply outcome to."`);
    expect(await call('hippo_recall', { query: 'staging lock deploys', budget: 4000 })).toMatchInlineSnapshot(`
      "## Cutoff
      Showing 1 of 2 candidates; 1 dropped to fit limit.

      ---

      Found 1 memories:

      [verified] tags: error, deploy (strength=1.00)
      the staging lock table blocks deploys
      "
    `);
    expect(await call('hippo_outcome', { good: true })).toMatchInlineSnapshot(`"Applied positive outcome to 1 memories"`);
    expect(await call('hippo_recall', { query: 'nothing matches zebra quartz' })).toMatchInlineSnapshot(`
      "## Cutoff
      Showing 0 of 2 candidates; 2 dropped to fit limit.

      ---

      No relevant memories found."
    `);

    expect(await call('hippo_context', { budget: 0 })).toMatchInlineSnapshot(`"Done."`);
    expect(await call('hippo_context', { budget: 3 })).toMatchInlineSnapshot(`"Done."`);
    expect(await call('hippo_context', { budget: 4000 })).toMatchInlineSnapshot(`"No relevant memories found."`);
    expect(await call('hippo_status')).toMatchInlineSnapshot(`
      "Memories: 2 (0 pinned, 1 errors)
      Avg strength: 1.00
      At risk (<0.1): 0
      Open conflicts: 0
      Half-life default: 365d"
    `);
  });

  it('assemble, drill, baserate, conflicts, resolve, share and peers', async () => {
    expect(await call('hippo_assemble', {})).toMatchInlineSnapshot(`"isError: Invalid arguments for hippo_assemble: session_id is required"`);
    expect(await call('hippo_assemble', { session_id: 'no-such-session' })).toMatchInlineSnapshot(`"Session no-such-session — 0 items, 20 tokens (raw=0, summarized=0, evicted=0)"`);
    expect(await call('hippo_drill', {})).toMatchInlineSnapshot(`"isError: Invalid arguments for hippo_drill: summary_id is required"`);
    expect(await call('hippo_drill', { summary_id: 'no-such-summary' })).toMatchInlineSnapshot(`"No drillable summary at id=no-such-summary."`);
    expect(await call('hippo_predict_baserate', { class_tag: '  ' })).toMatchInlineSnapshot(`"No class_tag provided. Usage: pass class_tag matching a class used in past predictions (e.g. "migration-effort")."`);
    expect(await call('hippo_predict_baserate', { class_tag: 'migration-effort' })).toMatchInlineSnapshot(`"No closed predictions in class "migration-effort" yet. Create one via hippo_predict (or 'hippo predict ...' CLI) and close it with hippo_predict_close once the actual outcome is known. Base rates need closed predictions with numeric actual_value to compute."`);
    expect(await call('hippo_conflicts')).toMatchInlineSnapshot(`"No open conflicts."`);
    expect(await call('hippo_resolve', { conflict_id: 1 })).toMatchInlineSnapshot(`"isError: Invalid arguments for hippo_resolve: keep is required"`);
    expect(await call('hippo_share', {})).toMatchInlineSnapshot(`"isError: Invalid arguments for hippo_share: id is required"`);
    expect(await call('hippo_peers')).toMatchInlineSnapshot(`"No peers found."`);
    expect(await settle('hippo_resolve', { conflict_id: 999, keep: 'mem_missing' })).toMatchInlineSnapshot(`"Could not resolve. Check the conflict ID and --keep value."`);
    expect(await settle('hippo_share', { id: 'mem_missing' })).toMatchInlineSnapshot(`"throws: Memory not found: mem_missing"`);
    expect(await settle('hippo_recall', { query: 'x', scorer_window: 'abc' })).toMatchInlineSnapshot(`"throws: scorerWindow must be a positive integer; got NaN"`);
  });

  it('learn reports its scan line and an unknown tool stays a JSON-RPC error', async () => {
    expect(await call('hippo_learn', { days: 1 })).toMatch(/^(No git history found\.|No fix\/revert\/bug commits found in the specified period\.|Git learn: \d+ new, \d+ duplicates skipped.* \(scanned 1 days\))$/);
    expect(await call('hippo_missing')).toMatchInlineSnapshot(`"error: Unknown tool: hippo_missing"`);
  });
});
