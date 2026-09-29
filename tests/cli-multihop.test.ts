import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// This checkout's own CLI, found from this file: not a global install, nor another worktree's via the cwd.
const HIPPO = `node ${JSON.stringify(fileURLToPath(new URL('../bin/hippo.js', import.meta.url)))}`;

describe('hippo recall --multihop', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cli-multihop-'));
    execSync(`${HIPPO} init --no-hooks --no-schedule --no-learn`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
    });
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('accepts --multihop flag without error', () => {
    execSync(`${HIPPO} remember "John loves basketball"`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
    });

    const result = execSync(`${HIPPO} recall "basketball" --multihop`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
      encoding: 'utf-8',
    });
    expect(result).toContain('basketball');
  });

  it('works without --multihop (normal recall)', () => {
    execSync(`${HIPPO} remember "Tim reads books"`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
    });

    const result = execSync(`${HIPPO} recall "reading"`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
      encoding: 'utf-8',
    });
    expect(result).toBeDefined();
  });
});
