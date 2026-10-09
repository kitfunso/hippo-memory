import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initStore } from '../src/store/open.js';

import {
  DAILY_TASK_NAME,
  buildDailyRunnerCommand,
  registerWorkspace,
  runDailyMaintenance,
  workspaceRegistryPath,
} from '../src/cli/scheduler.js';

// The registry stores forward-slash paths on every platform.
const norm = (p: string): string => resolve(p).replace(/\\/g, '/');
interface RegistryFile { version: number; workspaces: string[] }
// SAFETY: the file under test is written by registerWorkspace, whose shape the assertions then check.
const registryOf = (globalRoot: string): RegistryFile => JSON.parse(readFileSync(workspaceRegistryPath(globalRoot), 'utf8')) as RegistryFile;

describe('scheduler', () => {
  let root: string;
  let globalRoot: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'hippo-scheduler-')));
    globalRoot = join(root, 'global');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('registerWorkspace stores unique project roots in the global registry file', () => {
    const repoA = join(root, 'repo-a');
    const repoB = join(root, 'repo-b');
    mkdirSync(repoA);
    mkdirSync(repoB);

    registerWorkspace(globalRoot, repoB);
    registerWorkspace(globalRoot, repoA);
    expect(registryOf(globalRoot)).toEqual({ version: 1, workspaces: [norm(repoA), norm(repoB)].sort() });

    registerWorkspace(globalRoot, repoA);
    expect(registryOf(globalRoot)).toEqual({ version: 1, workspaces: [norm(repoA), norm(repoB)].sort() });
  });

  it('moves a damaged registry aside and writes a fresh one', () => {
    mkdirSync(globalRoot, { recursive: true });
    const registryFile = workspaceRegistryPath(globalRoot);
    writeFileSync(registryFile, '{ not json');
    const repo = join(root, 'repo-a');
    mkdirSync(repo);

    registerWorkspace(globalRoot, repo);

    expect(registryOf(globalRoot)).toEqual({ version: 1, workspaces: [norm(repo)] });
    const aside = readdirSync(globalRoot).filter((name) => name.startsWith('workspaces.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(globalRoot, aside[0]), 'utf8')).toBe('{ not json');
    expect(existsSync(registryFile)).toBe(true);
  });

  it('buildDailyRunnerCommand targets a single machine-level task entrypoint', () => {
    expect(DAILY_TASK_NAME).toBe('hippo-daily-runner');
    expect(buildDailyRunnerCommand('C:/Users/alice/hippo', 'win32')).toBe(
      'cd /d "C:/Users/alice/hippo" && hippo daily-runner',
    );
    expect(buildDailyRunnerCommand('/home/alice/.hippo', 'linux')).toBe(
      'cd "/home/alice/.hippo" && hippo daily-runner',
    );
  });

  it('runDailyMaintenance sweeps registered workspaces and skips missing stores', () => {
    // runCommand is an argument, so a fake here never spawns a real hippo.
    const runCommand = vi.fn();
    const [repoA, repoB, repoC] = ['repo-a', 'repo-b', 'repo-c'].map((name) => join(root, name));
    mkdirSync(join(repoA, '.hippo'), { recursive: true });
    mkdirSync(repoB, { recursive: true });
    mkdirSync(join(repoC, '.hippo'), { recursive: true });

    runDailyMaintenance([repoA, repoB, repoC], runCommand);

    expect(runCommand.mock.calls).toEqual([
      [norm(repoA), ['learn', '--git', '--days', '1']],
      [norm(repoA), ['sleep']],
      [norm(repoC), ['learn', '--git', '--days', '1']],
      [norm(repoC), ['sleep']],
    ]);
  });
});

describe('hippo daily-runner', () => {
  it('stops a child step at its deadline, names the workspace and reason, and exits 1 so the scheduler sees the failure', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hippo-daily-runner-')));
    try {
      const globalRoot = join(dir, 'global');
      const workspace = join(dir, 'repo');
      mkdirSync(globalRoot);
      mkdirSync(join(workspace, '.hippo'), { recursive: true });
      initStore(join(workspace, '.hippo'));
      writeFileSync(workspaceRegistryPath(globalRoot), JSON.stringify({ version: 1, workspaces: [workspace] }));
      const run = (extraEnv: Record<string, string>) => spawnSync(process.execPath, [resolve('bin', 'hippo.js'), 'daily-runner'], {
        cwd: dir,
        env: { ...process.env, HIPPO_HOME: globalRoot, HIPPO_SKIP_AUTO_INTEGRATIONS: '1', HIPPO_LOG: 'warn', HIPPO_LOG_FORMAT: '', ...extraEnv },
        encoding: 'utf8',
      });

      // One millisecond is less than a node start, so both child steps are stopped at the deadline.
      const cut = run({ HIPPO_DAILY_STEP_TIMEOUT_MS: '1' });
      expect(cut.stdout).toContain('0 workspaces processed, 2 command failures.');
      expect(cut.stderr).toMatch(/error: daily-runner failed in .*repo during `sleep`: timed out after 1 ms and was stopped .*workspace=.*repo/);
      expect(cut.stderr).toMatch(/daily-runner failed in .*workspace=.* errorClass=\w+ stack=\S*Error.* at /);
      expect(cut.status).toBe(1);

      // Control: the same workspace inside the default deadline is a clean run.
      const clean = run({});
      expect(clean.stdout).toContain('1 workspace processed, 0 command failures.');
      expect(clean.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
