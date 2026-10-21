/**
 * CLI integration tests for `hippo slack workspaces <add|list|remove>` (T2B 2026-05-24).
 *
 * Mirror of tests/connectors/slack-cli.test.ts pattern: runs each verb in process, asserts
 * stdout/stderr.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { makeStore } from '../_helpers/make-root.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

interface RunOptions {
  ok?: boolean; // when false, expect non-zero exit and return captured stderr
}

interface CliRunResult {
  stdout: string;
  stderr: string;
}

async function runCli(cwd: string, args: string[], opts: RunOptions = {}): Promise<CliRunResult> {
  const r = await runCliAs(args, { cwd, env: { ...process.env, HIPPO_HOME: join(cwd, '.hippo') } });
  if (r.status === 0) return { stdout: r.stdout, stderr: '' };
  if (opts.ok === false) return { stdout: r.stdout, stderr: r.stderr };
  throw new Error(`CLI exit ${r.status}: ${r.stderr}\nstdout: ${r.stdout}`);
}

describe('hippo slack workspaces CLI', () => {
  let root: string;

  beforeEach(() => {
    root = makeStore('slack-ws-cli').base;
  });

  it('add registers a team→tenant mapping and prints the envelope', async () => {
    const { stdout } = await runCli(root, ['slack', 'workspaces', 'add', '--team', 'T01', '--tenant', 'acme']);
    expect(stdout).toMatch(/added: T01 -> acme/);
  });

  it('list returns empty-state message when no workspaces are registered', async () => {
    const { stdout } = await runCli(root, ['slack', 'workspaces', 'list']);
    expect(stdout).toMatch(/no registered workspaces/);
  });

  it('list returns tab-separated rows for registered workspaces', async () => {
    await runCli(root, ['slack', 'workspaces', 'add', '--team', 'TAA', '--tenant', 'one']);
    await runCli(root, ['slack', 'workspaces', 'add', '--team', 'TBB', '--tenant', 'two']);
    const { stdout } = await runCli(root, ['slack', 'workspaces', 'list']);
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^TAA\tone\t/);
    expect(lines[1]).toMatch(/^TBB\ttwo\t/);
  });

  it('add upserts on existing team_id', async () => {
    await runCli(root, ['slack', 'workspaces', 'add', '--team', 'T01', '--tenant', 'acme']);
    await runCli(root, ['slack', 'workspaces', 'add', '--team', 'T01', '--tenant', 'globex']);
    const { stdout } = await runCli(root, ['slack', 'workspaces', 'list']);
    expect(stdout).toMatch(/^T01\tglobex\t/);
    expect(stdout.split('\n').filter((l) => l.startsWith('T01'))).toHaveLength(1);
  });

  it('remove deletes a registered workspace', async () => {
    await runCli(root, ['slack', 'workspaces', 'add', '--team', 'T01', '--tenant', 'acme']);
    const { stdout } = await runCli(root, ['slack', 'workspaces', 'remove', '--team', 'T01']);
    expect(stdout).toMatch(/removed: T01/);
    const { stdout: listOut } = await runCli(root, ['slack', 'workspaces', 'list']);
    expect(listOut).toMatch(/no registered workspaces/);
  });

  it('remove reports not-found for unknown team', async () => {
    const { stderr } = await runCli(root, ['slack', 'workspaces', 'remove', '--team', 'T_UNKNOWN'], { ok: false });
    expect(stderr).toMatch(/no workspace registered/);
  });

  it('add without --team prints usage and exits 1', async () => {
    const { stderr } = await runCli(root, ['slack', 'workspaces', 'add', '--tenant', 'acme'], { ok: false });
    expect(stderr).toMatch(/Usage:.*--team.*--tenant/);
  });

  it('add without --tenant prints usage and exits 1', async () => {
    const { stderr } = await runCli(root, ['slack', 'workspaces', 'add', '--team', 'T01'], { ok: false });
    expect(stderr).toMatch(/Usage:.*--team.*--tenant/);
  });

  it('unknown workspaces action prints workspaces usage and exits 1', async () => {
    const { stdout, stderr } = await runCli(root, ['slack', 'workspaces', 'frobnicate'], { ok: false });
    const combined = stdout + stderr;
    expect(combined).toMatch(/hippo slack workspaces <add\|list\|remove>/);
  });

  it('add --help prints usage without requiring flags', async () => {
    const { stdout } = await runCli(root, ['slack', 'workspaces', 'add', '--help']);
    expect(stdout).toMatch(/--team.*--tenant/);
  });
});
