import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

describe('hippo recall --multihop', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cli-multihop-'));
    execSync(`hippo init --no-hooks --no-schedule --no-learn`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
    });
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('accepts --multihop flag without error', () => {
    execSync(`hippo remember "John loves basketball"`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
    });

    const result = execSync(`hippo recall "basketball" --multihop`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
      encoding: 'utf-8',
    });
    expect(result).toContain('basketball');
  });

  it('works without --multihop (normal recall)', () => {
    execSync(`hippo remember "Tim reads books"`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
    });

    const result = execSync(`hippo recall "reading"`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
      encoding: 'utf-8',
    });
    expect(result).toBeDefined();
  });
});
