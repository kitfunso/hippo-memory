// Pins each MCP tool's reply text on a seeded store, including the early-return and refusal lines, so the per-tool dispatch cannot drift.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleMcpRequest, type McpContext, type McpResponse } from '../../src/surface/mcp/server.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeStore } from '../_helpers/make-root.js';
import { testReach } from '../_helpers/api-ctx.js';
import { loadConfig } from '../../src/base/config/config.js';
import { createCallerState } from '../../src/api/callers.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';
import { testInfra } from '../_helpers/infra.js';

oneRequestPerTest();

type Wire = string | number | boolean | null | Wire[] | { [key: string]: Wire };

let home: string;
let root: string;
let ctx: McpContext;

function text(res: McpResponse | null): string {
  // SAFETY: a tools/call reply is either a JSON-RPC error or a result with text content blocks.
  const r = res as {
    error?: { message: string };
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  } | null;
  if (r?.error) return `error: ${r.error.message}`;
  const body = r?.result?.content?.[0]?.text ?? '';
  return r?.result?.isError ? `isError: ${body}` : body;
}

async function call(name: string, args: Wire = {}): Promise<string> {
  return text(
    await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx),
  );
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
  ({ base: home, root } = makeStore('mcp-tool-text'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ autoSleep: { enabled: false } }), 'utf8');
  vi.stubEnv('HIPPO_HOME', join(home, 'global'));
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  // The context tool's auto query reads the checkout's git state, which differs between a dev branch and CI.
  vi.stubEnv('GIT_DIR', join(home, 'no-repo'));
  const store = sqliteStore(root);
  ctx = {
    hippoRoot: root,
    tenantId: 'default',
    actor: 'tester',
    role: 'admin',
    hostAdmin: true,
    clientKey: 'client-1',
    // The test is the transport root, so it keeps the client's last recall that an outcome with no ids lands on.
    callers: createCallerState(),
    store,
    reach: testReach(root, store),
    config: loadConfig(root),
    infra: testInfra(),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MCP tool reply text', () => {
  it('hippo_remember refuses empty text and reports the half-life and tags of what it stores', async () => {
    expect(masked(await call('hippo_remember', { text: '' }))).toMatchInlineSnapshot(`"No text provided."`);
    expect(
      masked(
        await call('hippo_remember', { text: 'the staging lock table blocks deploys', error: true, tag: 'deploy' }),
      ),
    ).toMatchInlineSnapshot(`"Remembered [<id>] (half-life: 730d, tags: error, deploy)"`);
    expect(
      masked(await call('hippo_remember', { text: 'release notes are folded from changelog fragments' })),
    ).toMatchInlineSnapshot(`"Remembered [<id>] (half-life: 365d, tags: none)"`);
  });

  describe('on a store holding two remembered rows', () => {
    beforeEach(async () => {
      await call('hippo_remember', { text: 'the staging lock table blocks deploys', error: true, tag: 'deploy' });
      await call('hippo_remember', { text: 'release notes are folded from changelog fragments' });
    });

    it('hippo_outcome has nothing to apply to before any recall', async () => {
      expect(await call('hippo_outcome', { good: true })).toMatchInlineSnapshot(
        `"No recent recalls to apply outcome to."`,
      );
    });

    it('hippo_recall lists the matching row, and hippo_outcome then applies to it', async () => {
      expect(await call('hippo_recall', { query: 'staging lock deploys', budget: 4000 })).toMatchInlineSnapshot(`
        "Found 1 memories:

        [verified] tags: error, deploy (strength=1.00)
        the staging lock table blocks deploys
        "
      `);
      expect(await call('hippo_outcome', { good: true })).toMatchInlineSnapshot(
        `"Applied positive outcome to 1 memories"`,
      );
    });

    it('hippo_recall reports the cutoff when nothing matches', async () => {
      expect(await call('hippo_recall', { query: 'nothing matches zebra quartz' })).toMatchInlineSnapshot(`
        "## Cutoff
        Showing 0 of 2 candidates; 2 not shown (rank, budget or limit).

        ---

        No relevant memories found."
      `);
    });

    it('hippo_context answers Done for a budget too small to hold a row', async () => {
      expect(await call('hippo_context', { budget: 0 })).toMatchInlineSnapshot(`"Done."`);
      expect(await call('hippo_context', { budget: 3 })).toMatchInlineSnapshot(`"Done."`);
    });

    it('hippo_context lists both rows within a large budget', async () => {
      expect(await call('hippo_context', { budget: 4000 })).toMatchInlineSnapshot(`
        "Found 2 memories:

        [verified] tags: error, deploy (strength=1.00)
        the staging lock table blocks deploys

        [verified] (strength=1.00)
        release notes are folded from changelog fragments
        "
      `);
    });

    it('hippo_status counts the rows', async () => {
      expect(await call('hippo_status')).toMatchInlineSnapshot(`
        "Memories: 2 (0 pinned, 1 errors)
        Avg strength: 1.00
        At risk (<0.2): 0
        Open conflicts: 0
        Half-life default: 365d"
      `);
    });

    it('hippo_recall throws on a scorer_window that is not a number', async () => {
      expect(await settle('hippo_recall', { query: 'x', scorer_window: 'abc' })).toMatchInlineSnapshot(
        `"throws: scorerWindow must be a positive integer; got NaN"`,
      );
    });
  });

  it('hippo_assemble needs a session id and reports an unknown session as empty', async () => {
    expect(await call('hippo_assemble', {})).toMatchInlineSnapshot(
      `"isError: Invalid arguments for hippo_assemble: session_id is required"`,
    );
    expect(await call('hippo_assemble', { session_id: 'no-such-session' })).toMatchInlineSnapshot(
      `"Session no-such-session — 0 items, 20 tokens (raw=0, summarized=0, evicted=0)"`,
    );
  });

  it('hippo_drill needs a summary id and reports an unknown one', async () => {
    expect(await call('hippo_drill', {})).toMatchInlineSnapshot(
      `"isError: Invalid arguments for hippo_drill: summary_id is required"`,
    );
    expect(await call('hippo_drill', { summary_id: 'no-such-summary' })).toMatchInlineSnapshot(
      `"No drillable summary at id=no-such-summary."`,
    );
  });

  it('hippo_predict_baserate refuses a blank class and reports a class with no closed predictions', async () => {
    expect(await call('hippo_predict_baserate', { class_tag: '  ' })).toMatchInlineSnapshot(
      `"No class_tag provided. Usage: pass class_tag matching a class used in past predictions (e.g. "migration-effort")."`,
    );
    expect(await call('hippo_predict_baserate', { class_tag: 'migration-effort' })).toMatchInlineSnapshot(
      `"No closed predictions in class "migration-effort" yet. Create one via hippo_predict (or 'hippo predict ...' CLI) and close it with hippo_predict_close once the actual outcome is known. Base rates need closed predictions with numeric actual_value to compute."`,
    );
  });

  it('hippo_conflicts reports no open conflicts', async () => {
    expect(await call('hippo_conflicts')).toMatchInlineSnapshot(`"No open conflicts."`);
  });

  it('hippo_resolve needs keep, and refuses an unknown conflict', async () => {
    expect(await call('hippo_resolve', { conflict_id: 1 })).toMatchInlineSnapshot(
      `"isError: Invalid arguments for hippo_resolve: keep is required"`,
    );
    expect(await settle('hippo_resolve', { conflict_id: 999, keep: 'mem_missing' })).toMatchInlineSnapshot(
      `"Could not resolve. Check the conflict ID and --keep value."`,
    );
  });

  it('hippo_share needs an id, and throws for a missing memory', async () => {
    expect(await call('hippo_share', {})).toMatchInlineSnapshot(
      `"isError: Invalid arguments for hippo_share: id is required"`,
    );
    expect(await settle('hippo_share', { id: 'mem_missing' })).toMatchInlineSnapshot(
      `"throws: Memory not found: mem_missing"`,
    );
  });

  it('hippo_peers reports no peers', async () => {
    expect(await call('hippo_peers')).toMatchInlineSnapshot(`"No peers found."`);
  });

  it('learn reports its scan line and an unknown tool stays a JSON-RPC error', async () => {
    expect(await call('hippo_learn', { days: 1 })).toMatch(
      /^(No git history found\.|No fix\/revert\/bug commits found in the specified period\.|Git learn: \d+ new, \d+ duplicates skipped.* \(scanned 1 days\))$/,
    );
    expect(await call('hippo_missing')).toMatchInlineSnapshot(`"error: Unknown tool: hippo_missing"`);
  });
});
