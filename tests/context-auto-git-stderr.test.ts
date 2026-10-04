// Git warnings on stderr must not leak into the auto-detected context query; only changed file names count.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { autoDetectContext } from '../src/context-auto.js';

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
    expect(autoDetectContext()).toBe('deployment txt');
  });
});
