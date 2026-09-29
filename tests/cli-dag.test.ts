import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

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

  it('runs without error and shows dag stats', () => {
    const result = execSync(`${HIPPO} dag --stats`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
      encoding: 'utf-8',
    });
    expect(result).toContain('DAG');
  });
});
