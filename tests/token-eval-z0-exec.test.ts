// Z0 runner git helper: a file in .git, a lock file or the index held by antivirus is retried and counted; any other failure throws at once.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { retryObjectLock, objectLockRetries, cloneFresh, git } from '../scripts/token-eval/exec.mjs';

const failed = (stderr: string): Error => Object.assign(new Error('Command failed: git add -A'), { status: 128, stderr });
const lockError = (): Error => failed('error: unable to write file C:\\w\\task one\\.git/objects/ed/5761b76fa3e3108be99db67d67ad64be345543: Permission denied\nfatal: adding files failed\n');
const NO_WAIT = [0, 0, 0, 0];

// Each shape seen on Windows while real-time scanning held a file git had just written.
const SCAN_LOCKS: [string, string][] = [
  ['an index git cannot replace', 'fatal: unable to write new index file\n'],
  ['an index update-index cannot replace', 'fatal: Unable to write new index file\n'],
  ['a ref lock on update-ref', "fatal: update_ref failed for ref 'refs/z0/pre': couldn't set 'refs/z0/pre'\n"],
  ['packed-refs on a clone', 'error replacing C:/w/repo-cache/seqA/.git/packed-refs: Permission denied\nfatal: remote did not send all necessary objects\n'],
  ['the config on a clone or a config set', "fatal: unable to access 'C:\\w\\repo-cache\\seqA\\.git\\config': Permission denied\n"],
  ['a temp index lock outside .git', "fatal: Unable to create 'C:/Users/u/AppData/Local/Temp/z0-git-Ab12/index.lock': Permission denied\n"],
];

const ORDINARY: [string, string][] = [
  ['a missing path', "fatal: pathspec 'x' did not match any files\n"],
  ['a bad revision', "fatal: bad revision 'nope'\n"],
  ['a merge conflict', 'CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.\n'],
  ['a work-tree file', "error: open(\"src/a.txt\"): Permission denied\nerror: unable to index file 'src/a.txt'\nfatal: adding files failed\n"],
  ['a lock another git holds', "fatal: Unable to create 'C:/w/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository.\n"],
  ['a commit whose HEAD already moved', 'fatal: repository has been updated, but unable to write\nnew index file. Check that disk is not full and quota is\nnot exceeded, and then "git restore --staged :/" to recover.\n'],
  ['a ref whose old value moved', "fatal: update_ref failed for ref 'refs/z0/pre': cannot lock ref 'refs/z0/pre': is at 1111111111111111111111111111111111111111 but expected 2222222222222222222222222222222222222222\n"],
];

describe('retryObjectLock', () => {
  it('reruns past a locked loose object and counts each retry', () => {
    const before = objectLockRetries.count;
    let calls = 0;
    const out = retryObjectLock(() => {
      calls++;
      if (calls < 3) throw lockError();
      return 'tree';
    }, NO_WAIT);
    expect(out).toBe('tree');
    expect(calls).toBe(3);
    expect(objectLockRetries.count - before).toBe(2);
  });

  it.each(SCAN_LOCKS)('reruns past %s and counts the retry', (_label, stderr) => {
    const before = objectLockRetries.count;
    let calls = 0;
    const out = retryObjectLock(() => {
      calls++;
      if (calls < 2) throw failed(stderr);
      return 'done';
    }, NO_WAIT);
    expect(out).toBe('done');
    expect(calls).toBe(2);
    expect(objectLockRetries.count - before).toBe(1);
  });

  it.each(ORDINARY)('throws %s on the first call', (_label, stderr) => {
    const before = objectLockRetries.count;
    let calls = 0;
    const other = failed(stderr);
    expect(() => retryObjectLock(() => {
      calls++;
      throw other;
    }, NO_WAIT)).toThrow(other);
    expect(calls).toBe(1);
    expect(objectLockRetries.count).toBe(before);
  });

  it('gives up after the last wait and throws the lock error', () => {
    let calls = 0;
    expect(() => retryObjectLock(() => {
      calls++;
      throw lockError();
    }, NO_WAIT)).toThrow(/git add -A/);
    expect(calls).toBe(NO_WAIT.length + 1);
  });
});

describe('cloneFresh', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 });
  });

  it('clears the partial dir a scan-locked clone left, then clones again', () => {
    const root = mkdtempSync(join(tmpdir(), 'z0-clone-'));
    dirs.push(root);
    const repo = join(root, 'source');
    mkdirSync(repo);
    const src = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    src('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    src('add', 'a.txt');
    src('-c', 'user.name=z0', '-c', 'user.email=z0@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'a');
    const dest = join(root, 'repo-cache', 'seqA');
    const before = objectLockRetries.count;
    let calls = 0;
    // The first try leaves what a clone does when packed-refs cannot be replaced: a .git dir with no history.
    const once = (args: string[]): string => {
      calls++;
      if (calls > 1) return git(args);
      mkdirSync(join(dest, '.git'), { recursive: true });
      writeFileSync(join(dest, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      throw failed(`error replacing ${dest}/.git/packed-refs: Permission denied\n`);
    };
    cloneFresh(repo, dest, once);
    expect(calls).toBe(2);
    expect(objectLockRetries.count - before).toBe(1);
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('a\n');
  });
});
