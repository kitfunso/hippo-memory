import { describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { workspaceRegistryPath } from '../../src/surface/cli/scheduler.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initTestStore } from '../_helpers/store-template.js';
import { PRIVATE_DIR } from '../../src/host/private-dir.js';

const HOUR_MS = 3_600_000;

function runner(cwd: string, globalRoot: string, extraEnv: Record<string, string> = {}) {
  return runCliAs(['daily-runner'], {
    cwd,
    env: {
      ...process.env,
      HIPPO_HOME: globalRoot,
      HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
      HIPPO_LOG: 'warn',
      HIPPO_LOG_FORMAT: '',
      ...extraEnv,
    },
  });
}

function withDb<T>(store: string, run: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(store);
  try {
    return run(db);
  } finally {
    closeHippoDb(db);
  }
}

const sleepCount = (store: string): number =>
  withDb(store, (db) => db.prepare('SELECT id FROM consolidation_runs').all().length);

function setup(label: string) {
  const dir = realpathSync(makeRoot(label, { init: false }));
  const globalRoot = join(dir, 'global');
  mkdirSync(globalRoot);
  initTestStore(globalRoot);
  return { dir, globalRoot };
}

describe('hippo daily-runner sleeps the global store', () => {
  it('sleeps it with no registered workspace, skips it inside 20 hours and sleeps it again after', async () => {
    const { dir, globalRoot } = setup('daily-global-none');

    const first = await runner(dir, globalRoot);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('1 workspace processed, 0 command failures.');
    expect(sleepCount(globalRoot)).toBe(1);

    const second = await runner(dir, globalRoot);
    expect(second.stdout).toContain('Skipped the global store: it slept at');
    expect(sleepCount(globalRoot)).toBe(1);

    const old = new Date(Date.now() - 21 * HOUR_MS).toISOString();
    withDb(globalRoot, (db) => db.prepare('UPDATE consolidation_runs SET timestamp = ?').run(old));
    await runner(dir, globalRoot);
    expect(sleepCount(globalRoot)).toBe(2);
  });

  it('sleeps the global store once when the registered home folder holds it', async () => {
    const dir = realpathSync(makeRoot('daily-global-home', { init: false }));
    const globalRoot = join(dir, '.hippo');
    mkdirSync(globalRoot);
    initTestStore(globalRoot);
    writeFileSync(
      workspaceRegistryPath(globalRoot),
      JSON.stringify({ version: 1, workspaces: [dir] }),
    );

    const result = await runner(dir, globalRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 workspace processed, 0 command failures.');
    expect(sleepCount(globalRoot)).toBe(1);
  });

  it('counts a failed global step and still runs the workspaces', async () => {
    const { dir, globalRoot } = setup('daily-global-fail');
    const workspace = join(dir, 'repo');
    mkdirSync(join(workspace, '.hippo'), PRIVATE_DIR);
    initTestStore(join(workspace, '.hippo'));
    writeFileSync(
      workspaceRegistryPath(globalRoot),
      JSON.stringify({ version: 1, workspaces: [workspace] }),
    );

    // One millisecond is less than a node start, so every child step is stopped at the deadline.
    const cut = await runner(dir, globalRoot, {
      HIPPO_DAILY_STEP_TIMEOUT_MS: '1',
    });

    expect(cut.stdout).toContain('Running daily maintenance across 1 registered workspace');
    expect(cut.stdout).toContain('0 workspaces processed, 3 command failures.');
    expect(cut.stderr).toMatch(/daily-runner failed in .* during `sleep --global --no-learn`/);
    expect(cut.status).toBe(1);
  });
});
