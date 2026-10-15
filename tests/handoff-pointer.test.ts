// Another session's handoff reaches the per-prompt hook as a pointer to its full text; every other reader gets it whole.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { saveSessionHandoff } from '../src/store/handoffs.js';
import { getContext, type ContextOpts } from '../src/api/index.js';
import { contextCost } from '../src/api/context-render.js';
import { promptHookContext } from '../src/api/prompt-hook.js';
import { handleContext } from '../src/cli/context.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { sqliteStore } from '../src/store/sqlite/store.js';
import type { SessionHandoff } from '../src/core/handoff.js';
import type { CliFlags } from '../src/cli/flag-values.js';
import { apiCtx } from './_helpers/api-ctx.js';
import { withHookStdin } from './_helpers/hook-stdin.js';
import { runInProcess } from './_helpers/run-in-process.js';

// hippo_context with no query asks git for the checkout's recent work, in child processes.
vi.setConfig({ testTimeout: 30_000 });

const SUMMARY = 'Moved the billing retries onto the queue; the dead-letter sweep still needs a dry run';
const PROJECT = { name: 'p', legacyName: 'p' };
const HOOK_FLAGS: CliFlags = { 'pinned-only': true, 'include-recent': '5', format: 'additional-context' };

let tmp: string;
let store: string;
let handoff: SessionHandoff;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-handoff-pointer-'));
  store = path.join(tmp, '.hippo');
  vi.stubEnv('HIPPO_HOME', path.join(tmp, 'global'));
  initStore(store);
  handoff = saveSessionHandoff(store, 'default', { version: 1, sessionId: 'earlier', summary: SUMMARY, nextAction: 'dry-run the sweep' });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function pointerOf(h: SessionHandoff): string {
  const at = h.updatedAt.slice(0, 16).replace('T', ' ');
  return `## Session Handoff\n\n- Another session left a handoff at ${at} UTC. ` +
    `If this task continues it, run \`hippo handoff latest --session ${h.sessionId}\`.\n`;
}

function additionalContext(stdout: string): string {
  // SAFETY: the hook's stdout is the UserPromptSubmit reply hookReply builds.
  return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

async function hookFrom(sessionId: string): Promise<string> {
  return additionalContext((await promptHookContext(apiCtx(store), { sessionId, project: PROJECT })).stdout);
}

async function cli(flags: CliFlags, stdin?: string): Promise<string> {
  const r = await runInProcess(() => withHookStdin(stdin, () => handleContext({ hippoRoot: store, tenantId: 'default', args: [], flags })));
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

const hookOpts = (budget: number, handoffMode?: ContextOpts['handoffMode']): ContextOpts =>
  ({ pinnedOnly: true, budget, cost: contextCost('additional-context', 'observe'), currentSessionId: 'now', handoffMode });

describe('the per-prompt hook', () => {
  it("prints another session's handoff as a pointer to the command that shows it", async () => {
    const text = await hookFrom('now');
    expect(text).toContain(pointerOf(handoff));
    expect(pointerOf(handoff).length).toBeLessThan(170);
    expect(text).not.toContain(SUMMARY);
  });

  it("prints the session's own handoff in full", async () => {
    const text = await hookFrom('earlier');
    expect(text).toContain('- Session: earlier');
    expect(text).toContain(SUMMARY);
    expect(text).not.toContain('Another session left a handoff');
  });

  it('prints the same pointer from the local CLI hook', async () => {
    const stdout = await cli(HOOK_FLAGS, JSON.stringify({ session_id: 'now', prompt: 'what is left on billing' }));
    expect(additionalContext(stdout)).toContain(pointerOf(handoff));
  });

  it("charges the budget the pointer's size, so a handoff too long to print whole still points", async () => {
    const long = saveSessionHandoff(store, 'default', { version: 1, sessionId: 'long', summary: `${SUMMARY}. `.repeat(30) });
    const full = await getContext(apiCtx(store), hookOpts(150, 'full'));
    expect(full.sessionHandoff).toBeUndefined();
    const pointer = await getContext(apiCtx(store), hookOpts(150, 'pointer'));
    expect(pointer.sessionHandoff?.sessionId).toBe(long.sessionId);
    expect(pointer.handoffMode).toBe('pointer');
  });
});

describe('every other reader', () => {
  it("gets another session's handoff in full from getContext by default", async () => {
    const result = await getContext(apiCtx(store), hookOpts(1500));
    expect(result.sessionHandoff?.summary).toBe(SUMMARY);
    expect(result.handoffMode).toBeUndefined();
  });

  it('gets it in full from the CLI as markdown and as JSON', async () => {
    expect(await cli({ budget: '1500' })).toContain(SUMMARY);
    // SAFETY: --format json prints the context JSON, whose sessionHandoff is a SessionHandoff.
    expect((JSON.parse(await cli({ budget: '1500', format: 'json' })) as { sessionHandoff: SessionHandoff }).sessionHandoff.summary).toBe(SUMMARY);
  });

  it('gets it in full from the MCP hippo_context tool', async () => {
    const cwd = process.cwd();
    // Outside git, so the auto query is empty.
    process.chdir(tmp);
    try {
      const res = await handleMcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_context', arguments: { budget: 1500 } } },
        { hippoRoot: store, tenantId: 'default', actor: 'mcp', role: 'admin', hostAdmin: true, store: sqliteStore(store) },
      );
      // SAFETY: a hippo_context reply carries one MCP text content block.
      const content = (res?.result as { content?: Array<{ text?: string }> } | undefined)?.content;
      expect(content?.[0]?.text).toContain(SUMMARY);
    } finally {
      process.chdir(cwd);
    }
  });
});
