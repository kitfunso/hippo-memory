import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  DAILY_TASK_NAME,
  buildDailyRunnerCommand,
  registerWorkspace,
  runDailyMaintenance,
  workspaceRegistryPath,
} from '../../src/surface/cli/scheduler.js';
import { makeRoot } from '../_helpers/make-root.js';
import { PRIVATE_DIR } from '../../src/host/private-dir.js';

// The registry stores forward-slash paths on every platform.
const norm = (p: string): string => resolve(p).replace(/\\/g, '/');
interface RegistryFile {
  version: number;
  workspaces: string[];
}
// SAFETY: the file under test is written by registerWorkspace, whose shape the assertions then check.
const registryOf = (globalRoot: string): RegistryFile =>
  JSON.parse(readFileSync(workspaceRegistryPath(globalRoot), 'utf8')) as RegistryFile;

describe('scheduler', () => {
  let root: string;
  let globalRoot: string;
  beforeEach(() => {
    root = realpathSync(makeRoot('scheduler', { init: false }));
    globalRoot = join(root, 'global');
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
    mkdirSync(join(repoA, '.hippo'), PRIVATE_DIR);
    mkdirSync(repoB, { recursive: true });
    mkdirSync(join(repoC, '.hippo'), PRIVATE_DIR);

    runDailyMaintenance([repoA, repoB, repoC], runCommand);

    expect(runCommand.mock.calls).toEqual([
      [norm(repoA), ['learn', '--git', '--days', '1']],
      [norm(repoA), ['sleep']],
      [norm(repoC), ['learn', '--git', '--days', '1']],
      [norm(repoC), ['sleep']],
    ]);
  });

  it('runDailyMaintenance learns in, but does not sleep, a workspace whose store is the global root', () => {
    const runCommand = vi.fn();
    const home = join(root, 'home');
    mkdirSync(join(home, '.hippo'), PRIVATE_DIR);

    runDailyMaintenance([home], runCommand, join(home, '.hippo'));

    expect(runCommand.mock.calls).toEqual([[norm(home), ['learn', '--git', '--days', '1']]]);
  });
});
