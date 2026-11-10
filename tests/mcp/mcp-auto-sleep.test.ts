// MCP auto-sleep: a remember that lands while a sleep runs on the same store must not start a second one.
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleMcpRequest } from '../../src/surface/mcp/server.js';
import { RequestStores } from '../../src/db/index.js';
import { SESSION_OPEN } from '../../src/db/request-stores.js';
import { sleepRuns } from '../_helpers/sleep-runs.js';
import { cliStdioHost } from '../../src/surface/cli/api-context.js';
import type { McpHost } from '../../src/surface/mcp/protocol.js';
import type { CliStore } from '../../src/surface/cli/api-context.js';
import { makeRoot } from '../_helpers/make-root.js';
import * as fileLock from '../../src/host/file-lock.js';
import { log } from '../../src/base/util/log.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A remember through `host`, whose callers hold the stores with a sleep in flight. */
function remember(host: McpHost<CliStore>, hippoRoot: string, text: string) {
  return host.runFrame(new AbortController().signal, (contextFor) =>
    handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_remember', arguments: { text } } },
      contextFor(hippoRoot, 'default'),
    ),
  );
}

describe('MCP auto-sleep', () => {
  it('runs one sleep per store at a time, and the next once that one settles', async () => {
    const root = makeRoot('mcp-autosleep');
    roots.push(root);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ autoSleep: { enabled: true, threshold: 1 } }));
    // A sleep sends each new episodic memory to fact extraction, so holding that reply keeps the sleep running.
    const sent: string[] = [];
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(String(init?.body));
        await held;
        return new Response(JSON.stringify({ content: [{ text: '[]' }] }), { status: 200 });
      }),
    );

    const host = cliStdioHost();
    await remember(host, root, 'the deploy moved to friday');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await remember(host, root, 'alice owns the billing service');
    release();
    await vi.waitFor(() => expect(sleepRuns(root)).toBe(1));
    expect(sent.filter((body) => body.includes('alice owns the billing service'))).toEqual([]);

    await remember(host, root, 'alice reviews every schema change');
    await vi.waitFor(() => expect(sleepRuns(root)).toBe(2));
  });

  it("runs in a session of its own, open while it runs, not the tool call's", async () => {
    const root = makeRoot('mcp-autosleep-scope');
    roots.push(root);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ autoSleep: { enabled: true, threshold: 1 } }));
    // Every open on a session goes through its SESSION_OPEN method, so its `this` names the session that made it.
    const sessions: RequestStores[] = [];
    const sessionOpen = RequestStores.prototype[SESSION_OPEN];
    const opens = vi.spyOn(RequestStores.prototype, SESSION_OPEN).mockImplementation(function (
      this: RequestStores,
      ...args: Parameters<RequestStores[typeof SESSION_OPEN]>
    ) {
      sessions.push(this);
      return sessionOpen.apply(this, args);
    });
    const seen: { session: RequestStores | undefined; open: boolean }[] = [];
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const session = sessions.at(-1);
        seen.push({ session, open: session !== undefined && !session.closed });
        return new Response(JSON.stringify({ content: [{ text: '[]' }] }), { status: 200 });
      }),
    );

    await remember(cliStdioHost(), root, 'the deploy moved to friday');
    const frame = sessions[0];
    await vi.waitFor(() => expect(sleepRuns(root)).toBe(1));
    opens.mockRestore();
    // One episodic memory is one extraction call; no later LLM pass has the facts or summaries it needs.
    expect(seen).toHaveLength(1);
    expect(frame?.closed).toBe(true);
    for (const s of seen) {
      expect(s.open).toBe(true);
      expect(s.session).not.toBe(frame);
    }
  });

  it("is kept by the loop's keeper, so its settle waits for the sleep a write started", async () => {
    const root = makeRoot('mcp-autosleep-kept');
    roots.push(root);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ autoSleep: { enabled: true, threshold: 1 } }));
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ content: [{ text: '[]' }] }), { status: 200 })),
    );
    const host = cliStdioHost();
    await remember(host, root, 'the deploy moved to friday');
    expect(await host.settle(20_000)).toBe(0);
    expect(sleepRuns(root)).toBe(1);
  });
});

describe('MCP auto-sleep and the store claim', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function autoSleepRoot(label: string): string {
    const root = makeRoot(label);
    roots.push(root);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ autoSleep: { enabled: true, threshold: 1 } }));
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ content: [{ text: '[]' }] }), { status: 200 })),
    );
    return root;
  }

  /** How many times a sleep reached for the store's claim, read from the lock it takes on the folder. */
  function claimsAsked(takes: MockInstance<typeof fileLock.takeFileLock>): number {
    return takes.mock.calls.filter(([file]) => file.endsWith('sleep.lock.db')).length;
  }

  it('tries once while another sleep holds the store, and again only after the backoff', async () => {
    const root = autoSleepRoot('mcp-autosleep-held');
    const rival = fileLock.takeFileLock(join(root, 'sleep.lock.db'));
    if (rival.kind !== 'taken') throw new Error(`test setup: the claim was already ${rival.kind}`);
    const takes = vi.spyOn(fileLock, 'takeFileLock');
    const skipped = vi.spyOn(log, 'info');
    const host = cliStdioHost();

    try {
      // Ten seconds apart, all inside the minute after the first refusal.
      for (const second of ['00', '10', '20', '30', '40']) {
        vi.stubEnv('HIPPO_FAKE_NOW', `2026-06-01T12:00:${second}.000Z`);
        await remember(host, root, `alice reviewed change ${second} to the deploy`);
        await host.settle(20_000);
      }

      expect(claimsAsked(takes)).toBe(1);
      expect(skipped.mock.calls.filter(([message]) => message.includes('already running'))).toHaveLength(1);
      expect(sleepRuns(root)).toBe(0);
    } finally {
      // The folder cannot be removed while the lock file is open.
      rival.lock.release();
    }
    vi.stubEnv('HIPPO_FAKE_NOW', '2026-06-01T12:01:01.000Z');
    await remember(host, root, 'alice reviewed the last change to the deploy');
    await host.settle(20_000);

    expect(claimsAsked(takes)).toBe(2);
    expect(sleepRuns(root)).toBe(1);
  });

  it('starts the next sleep at once after a sleep that ran, with no backoff', async () => {
    const root = autoSleepRoot('mcp-autosleep-claim-freed');
    const takes = vi.spyOn(fileLock, 'takeFileLock');
    const host = cliStdioHost();

    await remember(host, root, 'the deploy moved to friday');
    await host.settle(20_000);
    expect(sleepRuns(root)).toBe(1);
    await remember(host, root, 'alice reviews every schema change');
    await host.settle(20_000);

    expect(sleepRuns(root)).toBe(2);
    expect(claimsAsked(takes)).toBe(2);
  });
});
