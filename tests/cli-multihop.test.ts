import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

// The worktree's own CLI, not a PATH-resolved global install (which may be an older release).
const HIPPO = `node ${JSON.stringify(path.join(process.cwd(), 'bin', 'hippo.js'))}`;

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
