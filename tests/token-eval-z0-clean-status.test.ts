// commitInstructions on one workspace: the runner's instruction writes become one fixed commit on the stub, and the
// pre tree and a checker's `pre..HEAD` stay as they were. The full runs are in token-eval-z0-turns.test.ts.
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkoutBase, instructionSnapshot, commitInstructions, INSTRUCTIONS_MESSAGE, STUB_CLAUDE_MD } from '../scripts/token-eval/workspace.mjs';
import { stateCommit } from '../scripts/token-eval/checks.mjs';
import { cleanup, tmp, isolate, makeRepo } from './fixtures/z0-harness.js';

afterEach(cleanup);

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd();

describe('commitInstructions', () => {
  it('commits what git shows of the runner writes only; the pre tree is the same and pre..HEAD stays empty', () => {
    isolate('unit');
    const r = makeRepo({ '.gitignore': 'CLAUDE.local.md\n' });
    const work = tmp('z0-clean-work-');
    const stub = checkoutBase(r.repo, work, 'seqF', { id: 'u1', baseRef: r.base }, 'A1');
    // Setup's write is in the baseline, so it is the task's, never the runner's, and stays as every arm sees it.
    writeFileSync(join(work, 'AGENTS.md'), 'from setup\n');
    const baseline = instructionSnapshot(work);
    expect(commitInstructions(work, baseline)).toBeNull();
    writeFileSync(join(work, 'CLAUDE.md'), `${STUB_CLAUDE_MD}runner line\n`);
    writeFileSync(join(work, 'CLAUDE.local.md'), 'ignored, so never committed\n');
    mkdirSync(join(work, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(work, '.claude', 'rules', 'r.md'), 'carried rule\n');
    const before = instructionSnapshot(work);
    const oldPre = stateCommit(work, stub);
    const head = commitInstructions(work, baseline);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(work, 'log', '-1', '--format=%P|%an|%ae|%at|%ct|%s')).toBe(`${stub}|z0-eval|z0-eval@localhost|946684800|946684800|${INSTRUCTIONS_MESSAGE}`);
    expect(git(work, 'status', '--porcelain=v1', '-uall')).toBe('?? AGENTS.md');
    expect(git(work, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort()).toEqual(['.claude/rules/r.md', '.gitignore', 'CLAUDE.md', 'lib.js']);
    expect(instructionSnapshot(work)).toEqual(before);
    const pre = stateCommit(work, head!);
    expect(git(work, 'rev-parse', `${pre}^{tree}`)).toBe(git(work, 'rev-parse', `${oldPre}^{tree}`));
    expect(git(work, 'log', '--format=%s', `${pre}..HEAD`)).toBe('');
    // Pre on the stub, as before this commit existed, would hand a checker the runner's commit as the agent's.
    expect(git(work, 'log', '--format=%s', `${oldPre}..HEAD`)).toBe(INSTRUCTIONS_MESSAGE);
    expect(commitInstructions(work, baseline)).toBeNull();
    expect(git(work, 'rev-parse', 'HEAD')).toBe(head);
  }, 120_000);
});
