// scripts/affected-tests.mjs reading its change set from git, in a repo of its own.
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedSince } from '../../scripts/affected-tests.mjs';

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args],
    { cwd: repo, stdio: 'ignore' },
  );
}

/** A repo whose `base` branch holds a.ts and c.ts, with HEAD one commit on that adds b.ts. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'affected-tests-git-'));
  made.push(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'c.ts'), 'export const c = 3;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'branch', 'base');
  writeFileSync(join(repo, 'b.ts'), 'export const b = 2;\n');
  git(repo, 'add', 'b.ts');
  git(repo, 'commit', '-q', '-m', 'b');
  return repo;
}

describe('changedSince', () => {
  it('reads the repo it is given, not the folder the command runs from', () => {
    expect(changedSince(makeRepo(), 'base')).toEqual(['b.ts']);
  });

  it('adds staged and unstaged edits and new files to the commits since the base', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'export const a = 10;\n');
    git(repo, 'add', 'a.ts');
    writeFileSync(join(repo, 'c.ts'), 'export const c = 30;\n');
    writeFileSync(join(repo, 'd.ts'), 'export const d = 4;\n');
    expect(changedSince(repo, 'base').sort()).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  });
});
