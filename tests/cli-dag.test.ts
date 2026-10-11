import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { writeEntry } from '../src/store/entry-writes.js';

// This checkout's own CLI, found from this file: not a global install, nor another worktree's via the cwd.
const HIPPO = `node ${JSON.stringify(fileURLToPath(new URL('../bin/hippo.js', import.meta.url)))}`;

describe('hippo dag', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cli-dag-'));
    execSync(`${HIPPO} init --no-hooks --no-schedule --no-learn`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
    });
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('counts rows per DAG level and the level-1 facts with no parent', () => {
    const store = path.join(hippoRoot, '.hippo');
    const row = (content: string, dag_level: number, dag_parent_id?: string) => {
      const entry = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, dag_level, dag_parent_id });
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

    const result = execSync(`${HIPPO} dag --stats`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
      encoding: 'utf-8',
    });
    expect(result.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)).toEqual([
      'DAG Structure:',
      'Level 3 (entity profiles):  1',
      'Level 2 (topic summaries):  2',
      'Level 1 (extracted facts):  3',
      'Level 0 (raw memories):     2',
      'Unlinked facts: 1',
    ]);
  });
});
