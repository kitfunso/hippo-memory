// MCP learn, MCP context and the CLI's learn run git through the git runner and the folder the
// context's machine carries, not the process's own.
import { describe, expect, it } from 'vitest';
import { runLearnTool } from '../../src/surface/mcp/memory-tools.js';
import { runContextTool } from '../../src/surface/mcp/recall-tools.js';
import { learnFromRepo } from '../../src/surface/cli/shared.js';
import { asCommand } from '../_helpers/test-cli.js';
import { mcpApiContext } from '../../src/surface/mcp/protocol.js';
import { loadConfig } from '../../src/host/config-file.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import type { GitCall, GitRunner } from '../../src/base/ports/git.js';
import { makeRoot } from '../_helpers/make-root.js';
import { testInfra } from '../_helpers/infra.js';
import { mcpContext } from '../_helpers/mcp-context.js';

function stubGit() {
  const calls: GitCall[] = [];
  const git: GitRunner = {
    run: (_args, call) => {
      calls.push(call);
      return { ok: false, status: 128, error: new Error('not a repo') };
    },
  };
  return { git, calls } satisfies { git: GitRunner; calls: GitCall[] };
}

const INJECTED = '/injected/folder';

const withMachine = (git: GitRunner, cwd: string | undefined) => {
  const infra = testInfra();
  return { ...infra, machine: { ...infra.machine, git, cwd } };
};

function stdioContext(hippoRoot: string, git: GitRunner, cwd: string | undefined) {
  const store = sqliteStore(hippoRoot);
  const config = loadConfig(hippoRoot);
  const ctx = mcpContext({
    hippoRoot,
    tenantId: 'default',
    actor: 'mcp',
    role: 'admin',
    hostAdmin: true,
    stdio: true,
    store,
    config,
    infra: withMachine(git, cwd),
  });
  return { ctx, store, config };
}

describe('learn', () => {
  it('runs MCP hippo_learn through the injected git runner and folder', async () => {
    const hippoRoot = makeRoot('learn-ports-mcp');
    const { git, calls } = stubGit();
    const { ctx, store, config } = stdioContext(hippoRoot, git, INJECTED);
    const call = { args: { days: 30 }, ctx, hippoRoot, config, tenantId: 'default', store };
    const api = { ...mcpApiContext(ctx), store };
    const text = await runLearnTool({ ...call, api });
    expect(text).toBe('No git history found.');
    expect(calls.map((c) => c.cwd)).toEqual([INJECTED]);
  });

  it('learns nothing over MCP when the machine names no folder', async () => {
    const hippoRoot = makeRoot('learn-ports-no-folder');
    const { git, calls } = stubGit();
    const { ctx, store, config } = stdioContext(hippoRoot, git, undefined);
    const call = { args: {}, ctx, hippoRoot, config, tenantId: 'default', store };
    const api = { ...mcpApiContext(ctx), store };
    const text = await runLearnTool({ ...call, api });
    expect(text).toBe('No git history found.');
    expect(calls).toEqual([]);
  });

  it("detects MCP hippo_context's query through the injected git runner", async () => {
    const hippoRoot = makeRoot('context-ports-mcp');
    const { git, calls } = stubGit();
    const { ctx, store, config } = stdioContext(hippoRoot, git, INJECTED);
    await runContextTool({ args: {}, ctx, hippoRoot, config, tenantId: 'default', store });
    expect(calls.length).toBeGreaterThan(0);
  });

  it('runs the CLI learn through the git runner on its context', async () => {
    const hippoRoot = makeRoot('learn-ports-cli');
    const { git, calls } = stubGit();
    await asCommand((cli) => {
      const ctx = { ...cli.apiContext(hippoRoot, 'default'), infra: withMachine(git, INJECTED) };
      return learnFromRepo({ repoPath: '/some/repo', days: 5, ctx });
    });
    expect(calls.map((c) => c.cwd)).toEqual(['/some/repo']);
  });
});
