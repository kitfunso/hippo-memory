import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DAILY_TASK_NAME,
  buildDailyRunnerCommand,
  registerWorkspace,
  runDailyMaintenance,
  workspaceRegistryPath,
} from '../src/scheduler.js';

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('fs', () => fsMock);

describe('scheduler', () => {
  beforeEach(() => {
    fsMock.existsSync.mockReset();
    fsMock.mkdirSync.mockReset();
    fsMock.readFileSync.mockReset();
    fsMock.writeFileSync.mockReset();
  });

  it('registerWorkspace stores unique project roots in the global registry', () => {
    const registryFile = workspaceRegistryPath('C:/Users/skf_s/.hippo');
    let registryText = JSON.stringify({
      version: 1,
      workspaces: ['C:/Users/skf_s/repo-a'],
    });

    fsMock.existsSync.mockImplementation((target: string) => target === registryFile);
    fsMock.readFileSync.mockImplementation(() => registryText);
    fsMock.writeFileSync.mockImplementation((_target: string, text: string) => {
      registryText = text;
    });

    registerWorkspace('C:/Users/skf_s/.hippo', 'C:/Users/skf_s/repo-b');
    registerWorkspace('C:/Users/skf_s/.hippo', 'C:/Users/skf_s/repo-a');

    expect(fsMock.writeFileSync).toHaveBeenLastCalledWith(
      workspaceRegistryPath('C:/Users/skf_s/.hippo'),
      JSON.stringify(
        {
          version: 1,
          workspaces: ['C:/Users/skf_s/repo-a', 'C:/Users/skf_s/repo-b'],
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  });

  it('buildDailyRunnerCommand targets a single machine-level task entrypoint', () => {
    expect(DAILY_TASK_NAME).toBe('hippo-daily-runner');
    expect(buildDailyRunnerCommand('C:/Users/skf_s/hippo', 'win32')).toBe(
      'cd /d "C:/Users/skf_s/hippo" && hippo daily-runner',
    );
    expect(buildDailyRunnerCommand('/home/skf_s/.hippo', 'linux')).toBe(
      'cd "/home/skf_s/.hippo" && hippo daily-runner',
    );
  });

  it('runDailyMaintenance sweeps registered workspaces and skips missing stores', () => {
    const runCommand = vi.fn();

    fsMock.existsSync.mockImplementation((target: string) => {
      const normalized = String(target).replace(/\\/g, '/');
      return normalized === 'C:/Users/skf_s/repo-a/.hippo' || normalized === 'C:/Users/skf_s/repo-c/.hippo';
    });

    runDailyMaintenance(
      ['C:/Users/skf_s/repo-a', 'C:/Users/skf_s/repo-b', 'C:/Users/skf_s/repo-c'],
      runCommand,
    );

    expect(runCommand.mock.calls).toEqual([
      ['C:/Users/skf_s/repo-a', ['learn', '--git', '--days', '1']],
      ['C:/Users/skf_s/repo-a', ['sleep']],
      ['C:/Users/skf_s/repo-c', ['learn', '--git', '--days', '1']],
      ['C:/Users/skf_s/repo-c', ['sleep']],
    ]);
  });
});
