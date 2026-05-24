/**
 * CLI integration tests for `hippo slack workspaces <add|list|remove>` (T2B 2026-05-24).
 *
 * Mirror of tests/slack-cli.test.ts pattern: spawns the built bin, asserts
 * stdout/stderr. Requires `npm run build` to have produced bin/hippo.js.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';

const CLI = resolve(__dirname, '..', 'bin', 'hippo.js');

interface RunOpts {
  ok?: boolean; // when false, expect non-zero exit and return captured stderr
}

function runCli(cwd: string, args: string[], opts: RunOpts = {}): { stdout: string; stderr: string } {
  if (!existsSync(CLI)) {
    throw new Error(`bin/hippo.js not found at ${CLI} - run \`npm run build\` first`);
  }
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HIPPO_HOME: join(cwd, '.hippo') },
    });
    return { stdout, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    if (opts.ok === false) {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
    throw new Error(
      `CLI exit ${e.status}: ${e.stderr ?? ''}\nstdout: ${e.stdout ?? ''}`,
    );
  }
}

describe('hippo slack workspaces CLI', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-slack-ws-cli-'));
    initStore(join(root, '.hippo'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('add registers a team→tenant mapping and prints the envelope', () => {
    const { stdout } = runCli(root, ['slack', 'workspaces', 'add', '--team', 'T01', '--tenant', 'acme']);
    expect(stdout).toMatch(/added: T01 -> acme/);
  });

  it('list returns empty-state message when no workspaces are registered', () => {
    const { stdout } = runCli(root, ['slack', 'workspaces', 'list']);
    expect(stdout).toMatch(/no registered workspaces/);
  });

  it('list returns tab-separated rows for registered workspaces', () => {
    runCli(root, ['slack', 'workspaces', 'add', '--team', 'TAA', '--tenant', 'one']);
    runCli(root, ['slack', 'workspaces', 'add', '--team', 'TBB', '--tenant', 'two']);
    const { stdout } = runCli(root, ['slack', 'workspaces', 'list']);
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^TAA\tone\t/);
    expect(lines[1]).toMatch(/^TBB\ttwo\t/);
  });

  it('add upserts on existing team_id', () => {
    runCli(root, ['slack', 'workspaces', 'add', '--team', 'T01', '--tenant', 'acme']);
    runCli(root, ['slack', 'workspaces', 'add', '--team', 'T01', '--tenant', 'globex']);
    const { stdout } = runCli(root, ['slack', 'workspaces', 'list']);
    expect(stdout).toMatch(/^T01\tglobex\t/);
    expect(stdout.split('\n').filter((l) => l.startsWith('T01'))).toHaveLength(1);
  });

  it('remove deletes a registered workspace', () => {
    runCli(root, ['slack', 'workspaces', 'add', '--team', 'T01', '--tenant', 'acme']);
    const { stdout } = runCli(root, ['slack', 'workspaces', 'remove', '--team', 'T01']);
    expect(stdout).toMatch(/removed: T01/);
    const { stdout: listOut } = runCli(root, ['slack', 'workspaces', 'list']);
    expect(listOut).toMatch(/no registered workspaces/);
  });

  it('remove reports not-found for unknown team', () => {
    const { stderr } = runCli(root, ['slack', 'workspaces', 'remove', '--team', 'T_UNKNOWN'], { ok: false });
    expect(stderr).toMatch(/no workspace registered/);
  });

  it('add without --team prints usage and exits 1', () => {
    const { stderr } = runCli(root, ['slack', 'workspaces', 'add', '--tenant', 'acme'], { ok: false });
    expect(stderr).toMatch(/Usage:.*--team.*--tenant/);
  });

  it('add without --tenant prints usage and exits 1', () => {
    const { stderr } = runCli(root, ['slack', 'workspaces', 'add', '--team', 'T01'], { ok: false });
    expect(stderr).toMatch(/Usage:.*--team.*--tenant/);
  });

  it('unknown workspaces action prints workspaces usage and exits 1', () => {
    const { stdout, stderr } = runCli(root, ['slack', 'workspaces', 'frobnicate'], { ok: false });
    const combined = stdout + stderr;
    expect(combined).toMatch(/hippo slack workspaces <add\|list\|remove>/);
  });

  it('add --help prints usage without requiring flags', () => {
    const { stdout } = runCli(root, ['slack', 'workspaces', 'add', '--help']);
    expect(stdout).toMatch(/--team.*--tenant/);
  });
});
