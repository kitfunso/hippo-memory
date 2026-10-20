import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

/** `hippo <args>` run in this process from `cwd`, the call bin/hippo.js makes; a non-zero exit fails the test. */
async function hippo(cwd: string, ...args: string[]): Promise<string> {
  const saved = process.cwd();
  process.chdir(cwd);
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args]));
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  } finally {
    process.chdir(saved);
  }
}

describe('hippo dag', () => {
  let hippoRoot: string;

  beforeEach(async () => {
    hippoRoot = makeRoot('cli-dag', { init: false });
    vi.stubEnv('HIPPO_HOME', hippoRoot);
    await hippo(hippoRoot, 'init', '--no-hooks', '--no-schedule', '--no-learn');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('counts rows per DAG level and the level-1 facts with no parent', async () => {
    const store = path.join(hippoRoot, '.hippo');
    const row = (content: string, dagLevel: number, dagParentId?: string) => {
      const entry = createMemory(content, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        dagLevel,
        dagParentId,
      });
      writeEntry(store, entry);
      return entry.id;
    };
    const profile = row('Entity profile for the billing service', 3);
    const summary = row('Topic summary of billing retries', 2, profile);
    row('Orphan topic summary of release notes', 2);
    row('Retries back off for 30 seconds', 1, summary);
    row('Retries stop after five attempts', 1, summary);
    row('A fact nobody summarised yet', 1);
    row('Raw note one', 0);
    row('Raw note two', 0);

    const result = await hippo(hippoRoot, 'dag', '--stats');
    expect(
      result
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ).toEqual([
      'DAG Structure:',
      'Level 3 (entity profiles):  1',
      'Level 2 (topic summaries):  2',
      'Level 1 (extracted facts):  3',
      'Level 0 (raw memories):     2',
      'Unlinked facts: 1',
    ]);
  });
});
