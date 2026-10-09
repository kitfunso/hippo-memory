// Z0 G5 (prereg 166): each graded cell's trees and verdicts are saved outside the workspace before its .git is rebuilt.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanup, isolate, makeRepo, oneLesson, run, tmp } from './fixtures/z0-harness.js';

describe('per-cell grading save', () => {
  afterEach(cleanup);

  it('keeps a bundle that outlives the workspace .git, reader diffs without instruction files, grade.json and the applies\' surface text', async () => {
    const { out } = isolate('grading');
    const r = makeRepo();
    await run(oneLesson(r, { t1: 'FIX\nCARRY\nBINFILE\nLESSON_BAD', a1: 'MEMWRITE:apply note\nLESSON_OK' }), ['A1'], out);
    const dir = join(out, 'grading', 'seqF', 'A1', 'seed1');
    const grade = JSON.parse(readFileSync(join(dir, 't1.grade.json'), 'utf8'));
    expect(grade).toMatchObject({ sequence: 'seqF', arm: 'A1', seed: 1, taskId: 't1', kind: 'teach', lessonId: 'f1-l1', stubRef: 'refs/eval/seqF/t1' });
    expect(grade.verdicts).toEqual({ first: 'fail', final: 'pass', staleFollow: null });
    expect(grade.checkers['f1-l1']).toMatch(/^[0-9a-f]{64}$/);

    // A fresh repo holding only the stub's history takes the bundle, so nothing depends on the rebuilt workspace.
    const fresh = tmp('z0-grade-fresh-');
    const g = (...args: string[]) => execFileSync('git', args, { cwd: fresh, encoding: 'utf8' }).trim();
    g('init', '-q');
    g('fetch', '-q', join(out, 'repo-cache', 'seqF'), `${grade.stubRef}:refs/stub`);
    g('fetch', '-q', join(dir, 't1.bundle'), 'refs/z0/grade/*:refs/grade/*');
    expect(g('rev-parse', 'refs/grade/pre^')).toBe(grade.stub);
    expect(g('rev-parse', 'refs/stub')).toBe(grade.stub);
    expect(g('rev-parse', 'refs/grade/pre', 'refs/grade/first', 'refs/grade/final').split('\n')).toEqual([grade.pre, grade.first, grade.final]);
    expect(grade.first).not.toBe(grade.final);

    const first = readFileSync(join(dir, 't1.first.diff'), 'utf8');
    expect(first).toContain('lib.js');
    expect(first).toContain('.scratch/note.md');
    expect(first).toMatch(/Binary files .*blob\.bin/);
    expect(first).not.toContain('GIT binary patch');
    for (const f of ['CLAUDE.md', 'AGENTS.md', '.claude/rules/r.md']) expect(first).not.toContain(`b/${f}`);
    expect(readFileSync(join(dir, 't1.final.diff'), 'utf8')).toContain('lesson.txt');

    expect(JSON.parse(readFileSync(join(dir, 'n1.grade.json'), 'utf8')).verdicts).toEqual({ first: null, final: null, staleFollow: null });
    expect(existsSync(join(dir, 't1.surfaces.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'a2.surfaces.txt'), 'utf8')).toContain('apply note');
    expect(existsSync(join(dir, 'a1.surfaces.txt'))).toBe(true);
  }, 300_000);
});
