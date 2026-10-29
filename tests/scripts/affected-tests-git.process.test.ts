// scripts/affected-tests.mjs reading its change set from git, in a repo of its own.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedSince } from '../../scripts/affected-tests.mjs';

let repo: string;

function git(...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args],
    { cwd: repo, stdio: 'ignore' },
  );
}

function commit(file: string, text: string): void {
  writeFileSync(join(repo, file), text);
  git('add', file);
  git('commit', '-q', '-m', file);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'affected-tests-git-'));
  git('init', '-q');
  commit('a.ts', 'export const a = 1;\n');
  commit('b.ts', 'export const b = 2;\n');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('changedSince', () => {
  it('reads the repo it is given, not the folder the command runs from', () => {
    expect(changedSince(repo, 'HEAD~1')).toEqual(['b.ts']);
  });
});
