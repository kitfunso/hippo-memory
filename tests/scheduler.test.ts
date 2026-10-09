import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initStore } from '../src/store/open.js';

import {
  DAILY_TASK_NAME,
  __setSchedulerFsDeps,
  buildDailyRunnerCommand,
  registerWorkspace,
  runDailyMaintenance,
  workspaceRegistryPath,
} from '../src/cli/scheduler.js';

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
