// MCP learn, MCP context and the CLI's learn run git through the git runner and the folder the
// context's machine carries, not the process's own.
import { describe, expect, it } from 'vitest';
import { learnFromRepo } from '../../src/surface/cli/shared.js';
import { asCommand } from '../_helpers/test-cli.js';
import { loadConfig } from '../../src/host/config-file.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import type { GitCall, GitRunner } from '../../src/base/ports/git.js';
import { makeRoot } from '../_helpers/make-root.js';
import { testInfra } from '../_helpers/infra.js';
import { mcpContext, runMcpTool } from '../_helpers/mcp-context.js';

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
  return mcpContext({
    hippoRoot,
    tenantId: 'default',
    actor: 'mcp',
    role: 'admin',
    hostAdmin: true,
    stdio: true,
    store: sqliteStore(hippoRoot),
    config: loadConfig(hippoRoot),
    infra: withMachine(git, cwd),
  });
}

describe('learn', () => {
  it('runs MCP hippo_learn through the injected git runner and folder', async () => {
    const hippoRoot = makeRoot('learn-ports-mcp');
    const { git, calls } = stubGit();
    const ctx = stdioContext(hippoRoot, git, INJECTED);
    const text = await runMcpTool(ctx, 'hippo_learn', { days: 30 });
    expect(text).toBe('No git history found.');
    expect(calls.map((c) => c.cwd)).toEqual([INJECTED]);
  });

  it('learns nothing over MCP when the machine names no folder', async () => {
    const hippoRoot = makeRoot('learn-ports-no-folder');
    const { git, calls } = stubGit();
    const ctx = stdioContext(hippoRoot, git, undefined);
    const text = await runMcpTool(ctx, 'hippo_learn', {});
    expect(text).toBe('No git history found.');
    expect(calls).toEqual([]);
  });

  it("detects MCP hippo_context's query through the injected git runner", async () => {
    const hippoRoot = makeRoot('context-ports-mcp');
    const { git, calls } = stubGit();
    await runMcpTool(stdioContext(hippoRoot, git, INJECTED), 'hippo_context', {});
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
