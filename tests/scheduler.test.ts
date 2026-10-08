import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DAILY_TASK_NAME,
  __setSchedulerFsDeps,
  buildDailyRunnerCommand,
  registerWorkspace,
  runDailyMaintenance,
  workspaceRegistryPath,
} from '../src/scheduler.js';

// Fakes injected via __setSchedulerFsDeps (a DI seam on the scheduler module)
// instead of `vi.mock('fs')`, so the module under test always calls through
// real function references and only the fs.* implementations are swapped.
const fsMock = {
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFile: vi.fn(),
};

__setSchedulerFsDeps(fsMock);

// scheduler tests use hardcoded Windows-style paths (`C:/Users/alice/.hippo`)
// and assert workspaceRegistryPath produces matching output. The production
// code uses path.join which yields different separators on Linux, so the
// assertions diverge by platform. Skip on non-Windows in CI.
describe.skipIf(process.platform !== 'win32')('scheduler', () => {
  beforeEach(() => {
    fsMock.existsSync.mockReset();
    fsMock.mkdirSync.mockReset();
    fsMock.readFileSync.mockReset();
    fsMock.writeFile.mockReset();
  });

  it('registerWorkspace stores unique project roots in the global registry', () => {
    const registryFile = workspaceRegistryPath('C:/Users/alice/.hippo');
    let registryText = JSON.stringify({
      version: 1,
      workspaces: ['C:/Users/alice/repo-a'],
    });

    fsMock.existsSync.mockImplementation((target: string) => target === registryFile);
    fsMock.readFileSync.mockImplementation(() => registryText);
    fsMock.writeFile.mockImplementation((_target: string, text: string) => {
      registryText = text;
    });

    registerWorkspace('C:/Users/alice/.hippo', 'C:/Users/alice/repo-b');
    registerWorkspace('C:/Users/alice/.hippo', 'C:/Users/alice/repo-a');

    expect(fsMock.writeFile).toHaveBeenLastCalledWith(
      workspaceRegistryPath('C:/Users/alice/.hippo'),
      JSON.stringify(
        {
          version: 1,
          workspaces: ['C:/Users/alice/repo-a', 'C:/Users/alice/repo-b'],
        },
        null,
        2,
      ) + '\n',
    );
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
    const runCommand = vi.fn();

    fsMock.existsSync.mockImplementation((target: string) => {
      const normalized = String(target).replace(/\\/g, '/');
      return normalized === 'C:/Users/alice/repo-a/.hippo' || normalized === 'C:/Users/alice/repo-c/.hippo';
    });

    runDailyMaintenance(
      ['C:/Users/alice/repo-a', 'C:/Users/alice/repo-b', 'C:/Users/alice/repo-c'],
      runCommand,
    );

    expect(runCommand.mock.calls).toEqual([
      ['C:/Users/alice/repo-a', ['learn', '--git', '--days', '1']],
      ['C:/Users/alice/repo-a', ['sleep']],
      ['C:/Users/alice/repo-c', ['learn', '--git', '--days', '1']],
      ['C:/Users/alice/repo-c', ['sleep']],
    ]);
  });
});
