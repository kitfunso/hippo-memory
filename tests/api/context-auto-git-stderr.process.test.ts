// Git warnings on stderr must not leak into the auto-detected context query; only changed file names count.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { autoDetectContext } from '../../src/api/context-auto.js';
import { processGit } from '../../src/infra/git-runner.js';

let repo: string;
let prevCwd: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true });
}

beforeEach(() => {
  prevCwd = process.cwd();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ctx-auto-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'core.autocrlf', 'true');
  fs.writeFileSync(path.join(repo, 'deployment.txt'), 'one\n');
  git('add', 'deployment.txt');
  git('commit', '-qm', 'init');
  // An LF file under autocrlf=true makes `git diff` print a line-ending warning on stderr while exiting 0.
  fs.writeFileSync(path.join(repo, 'deployment.txt'), 'one\ntwo\n');
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('autoDetectContext', () => {
  it('builds the query from changed file names only', () => {
    expect(autoDetectContext(processGit)).toBe('deployment txt');
  });

  it('logs at debug why no git-derived query came back, and returns empty', () => {
    // A repo with no commit makes `git diff HEAD` fail, which stands for any git error or timeout.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ctx-auto-empty-'));
    execFileSync('git', ['init', '-q'], { cwd: empty, stdio: 'ignore', windowsHide: true });
    process.chdir(empty);
    vi.stubEnv('HIPPO_LOG', 'debug');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(autoDetectContext(processGit)).toBe('');
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('auto context: no git-derived query');
    } finally {
      stderr.mockRestore();
      vi.unstubAllEnvs();
      process.chdir(repo);
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
