// Z0 G5 (prereg 166): every saved check and acceptance test runs again on the saved commits; flips drop lessons, harness faults are error rows.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkerIdentity } from '../scripts/token-eval/lessons.mjs';
import { CHECKS, cleanup } from './fixtures/z0-harness.js';
import { cli, copyOut, dumpsIn, grading, keyOf, lessonOf, readGrading, regrade, rowFor, rowsOf, sharedRun, TOKEN, type Shared } from './fixtures/z0-regrade.js';

const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
let shared: Shared;
const gradeOf = (out: string, id: string) => JSON.parse(readFileSync(join(out, 'grading', 'seqF', 'A0', 'seed1', `${id}.grade.json`), 'utf8'));
const bundleOf = (out: string, id: string) => join(out, 'grading', 'seqF', 'A0', 'seed1', `${id}.bundle`);
const dumpOf = (dir: string, f: string): Record<string, string> => JSON.parse(readFileSync(join(dir, f), 'utf8'));

describe('z0-regrade regrade and grading', () => {
  beforeAll(async () => {
    shared = await sharedRun('regrade');
  }, 600_000);
  afterAll(() => {
    cleanup();
    if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
  });

  it('a stable checker gives zero flips, and grading.json holds E7\'s three fields plus g5 (1)', async () => {
    const c = copyOut(shared);
    const r = await regrade(c);
    expect(r.stderr).toBe('');
    expect(r).toMatchObject({ code: 0, stdout: 'repro: regraded 8 cells (0 with errors), skipped 0 done ones\n' });
    const rows = rowsOf(c.out);
    expect(rows.map((x) => x.status)).toEqual(Array(8).fill('done'));
    expect(rows.flatMap((x) => x.checks).filter((x) => x.flip)).toEqual([]);
    expect(rows.filter((x) => x.acceptance?.flip)).toEqual([]);
    // The teach was resumed, so its final check ran again; the stale check rides on a4.
    expect(rowFor(c.out, 't1').checks.map((x) => x.which)).toEqual(['first', 'final']);
    expect(rowFor(c.out, 'a4').checks.map((x) => [x.lessonId, x.which, x.saved, x.regraded])).toEqual([['f1-l2', 'first', 'pass', 'pass'], ['f1-l2', 'final', 'pass', 'pass'], ['f1-l1', 'stale', true, true]]);
    expect(rowFor(c.out, 'n1').checks).toEqual([]);
    expect(await grading(c.out)).toMatchObject({ code: 0 });
    const g = readGrading(c.out);
    expect(Object.keys(g)).toEqual(['acceptanceFlips', 'flippedLessons', 'g5', 'readerSample']);
    expect(g).toMatchObject({ flippedLessons: [], acceptanceFlips: 0, g5: { pass: 'repro', cells: 8, unreproducible: { cells: 0, lessons: [] }, extraEnvKeys: [] } });
    expect(readFileSync(join(c.out, 'grading.json'), 'utf8').endsWith('}\n')).toBe(true);
    // A reader round on a real run: pairs come from the saved bundles, and labels equal to the key score zero disagreements.
    expect(await cli(['reader', '--out', c.out, '--tasks', c.tasks, '--seed', '7'])).toMatchObject({ code: 0, stdout: expect.stringContaining('reader round 1: drew') });
    const pairs: { file: string; verdict: string }[] = JSON.parse(readFileSync(join(c.out, 'g5', 'sealed', 'reader-r1.key.json'), 'utf8')).pairs;
    const labels = join(c.out, 'labels-r1.tsv');
    writeFileSync(labels, pairs.map((p) => `${p.file}\t${p.verdict}\n`).join(''));
    expect(await cli(['reader', '--out', c.out, '--labels', labels])).toMatchObject({ code: 0 });
    expect(await grading(c.out)).toMatchObject({ code: 0 });
    expect(readGrading(c.out)).toMatchObject({ readerSample: { n: pairs.length, disagreements: 0 }, g5: { readerRound: 1 } });
    expect(pairs.length).toBeGreaterThan(0);
  }, 300_000);

  it('a checker that fails at the regrade puts its lesson in flippedLessons (2)', async () => {
    const c = copyOut(shared);
    expect(await regrade(c, [], { Z0_TOGGLE: 'regrade' })).toMatchObject({ code: 0 });
    expect(rowFor(c.out, 'a1').checks[0]).toMatchObject({ lessonId: 'f1-l1', which: 'first', saved: 'pass', regraded: 'fail', flip: true, reason: 'verdict' });
    expect(await grading(c.out)).toMatchObject({ code: 0 });
    expect(readGrading(c.out)).toMatchObject({ flippedLessons: ['f1-l1'], acceptanceFlips: 0 });
  }, 300_000);

  it('na against a saved pass flips the main lesson, and a key only the regrade has is a warning by name (3, R27)', async () => {
    const c = copyOut(shared);
    const r = await regrade(c, ['--cell', keyOf('a1'), '--cell', keyOf('a4')], { Z0_TOGGLE: 'regrade', Z0_TOGGLE_TO: '3' });
    expect(r).toMatchObject({ code: 0 });
    expect(rowFor(c.out, 'a1').checks[0]).toMatchObject({ saved: 'pass', regraded: 'na', flip: true, reason: 'verdict' });
    // The stale lesson is compared as pass-ness (reading 6): na is not a pass.
    expect(rowFor(c.out, 'a4').checks[2]).toMatchObject({ which: 'stale', saved: true, regraded: false, flip: true });
    expect(rowFor(c.out, 'a1').extraEnvKeys).toEqual(['Z0_TOGGLE_TO']);
  }, 300_000);

  it('a checker crash is a flip with reason checker-error, never an error row; a post-fix pass records the new checker (4)', async () => {
    const c = copyOut(shared);
    expect(await regrade(c, ['--cell', keyOf('a1')], { Z0_TOGGLE: 'regrade', Z0_TOGGLE_TO: '7' })).toMatchObject({ code: 0 });
    expect(rowFor(c.out, 'a1')).toMatchObject({ status: 'done', error: null });
    expect(rowFor(c.out, 'a1').checks[0]).toMatchObject({ regraded: 'error', flip: true, reason: 'checker-error' });

    const swapped = copyOut(shared, (s) => {
      lessonOf(s, 'f1-l1').check = { script: join(CHECKS, 'crash-on-toggle.mjs'), args: [] };
    });
    expect(await regrade(swapped, ['--post-fix', '--cell', keyOf('a1')], { Z0_TOGGLE: 'regrade' })).toMatchObject({ code: 0 });
    const row = rowFor(swapped.out, 'a1', 'postfix');
    const sha = checkerIdentity({ checkPath: join(CHECKS, 'crash-on-toggle.mjs'), check: { script: 'crash-on-toggle.mjs', args: [] } });
    expect(row).toMatchObject({ status: 'done', pass: 'postfix' });
    expect(row.checks[0]).toMatchObject({ regraded: 'error', second: 'error', flip: true, reason: 'checker-error', checkerSha: sha });
  }, 300_000);

  it('a fix that changes only check.args is a fix: both post-fix runs agree, so no flip and the lesson stays (4b)', async () => {
    const fixed = copyOut(shared, (s) => {
      lessonOf(s, 'f1-l1').check = { script: join(CHECKS, 'toggle.mjs'), args: ['var=Z0_TOGGLE_TEST'] };
    });
    expect(await regrade(fixed, ['--post-fix', '--cell', keyOf('a1')], { Z0_TOGGLE_TEST: 'regrade' })).toMatchObject({ code: 0 });
    const [check] = rowFor(fixed.out, 'a1', 'postfix').checks;
    expect(check).toMatchObject({ saved: 'pass', regraded: 'fail', second: 'fail', flip: false, reason: null });
    const sha = createHash('sha256').update(readFileSync(join(CHECKS, 'toggle.mjs'))).digest('hex');
    expect(check.checkerSha).not.toBe(sha);
    // A repro pass has no fix to allow, so the same args change is checker-changed there.
    expect(await regrade(fixed, ['--cell', keyOf('a1')], { Z0_TOGGLE_TEST: 'regrade' })).toMatchObject({ code: 0 });
    expect(rowFor(fixed.out, 'a1')).toMatchObject({ status: 'error', error: { stage: 'checker-changed' } });
  }, 300_000);

  it('a missing bundle is an error row; grading refuses until --flip-errors drops the cell\'s lessons (5, R6)', async () => {
    const c = copyOut(shared);
    rmSync(bundleOf(c.out, 'a1'));
    expect(await regrade(c)).toMatchObject({ code: 0, stdout: expect.stringContaining('regraded 8 cells (1 with errors)') });
    expect(rowFor(c.out, 'a1')).toMatchObject({ status: 'error', error: { stage: 'bundle' }, checks: [], acceptance: null });
    const refused = await grading(c.out);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`${keyOf('a1')} (repro, bundle)`);
    expect(await grading(c.out, ['--flip-errors'])).toMatchObject({ code: 0 });
    expect(readGrading(c.out)).toMatchObject({ flippedLessons: ['f1-l1'], acceptanceFlips: 1, g5: { unreproducible: { cells: 1, lessons: ['f1-l1'] } } });
  }, 300_000);

  it('a truncated bundle fails verify before setup and is an error row like a missing one (6)', async () => {
    const c = copyOut(shared);
    const file = bundleOf(c.out, 'a1');
    writeFileSync(file, readFileSync(file).subarray(0, Math.floor(statSync(file).size / 2)));
    expect(await regrade(c, ['--cell', keyOf('a1')])).toMatchObject({ code: 0 });
    expect(rowFor(c.out, 'a1')).toMatchObject({ status: 'error', error: { stage: 'bundle' } });
  }, 300_000);

  it('the checker sees the run\'s env but for Z0_COMMANDS and the three homes, which start empty under rg/; the token reaches neither (9)', async () => {
    const c = copyOut(shared);
    const before = dumpsIn(shared.dumps);
    expect(await regrade(c, ['--cell', keyOf('t2')])).toMatchObject({ code: 0 });
    const added = dumpsIn(shared.dumps).filter((f) => !before.includes(f));
    expect(added).toHaveLength(2);
    const grade = gradeOf(c.out, 't2');
    const runDumps = before.map((f) => dumpOf(shared.dumps, f));
    for (const [i, post] of [grade.first, grade.finalCheck].entries()) {
      const now = dumpOf(shared.dumps, added[i]);
      const then = runDumps.find((d) => d.Z0_POST_COMMIT === post && d.Z0_LESSON_ID === 'f2-l1')!;
      expect(then).toBeDefined();
      const keys = [...new Set([...Object.keys(then), ...Object.keys(now)])];
      expect(keys.filter((k) => then[k] !== now[k]).sort()).toEqual(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HIPPO_HOME', 'Z0_COMMANDS']);
      const mapped = (p: string) => p.replace(join(shared.out, 'runs'), join(realpathSync.native(c.out), 'rg'));
      for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HIPPO_HOME']) expect(now[k]).toBe(mapped(then[k]));
      // One commands file per cell, so after both calls it holds the final check's list.
      if (i === 1) expect(JSON.parse(readFileSync(now.Z0_COMMANDS, 'utf8'))).toEqual(grade.commandsFinal);
      for (const d of [then, now]) expect(Object.keys(d).some((k) => k.toUpperCase() === 'CLAUDE_CODE_OAUTH_TOKEN') || Object.values(d).includes(TOKEN)).toBe(false);
    }
  }, 300_000);

  it('a --pass-env name or a run env key missing now is refused before any cell (10, R27)', async () => {
    const c = copyOut(shared);
    const unset = await regrade(c, [], { Z0_ENV_DUMP_DIR: undefined });
    expect(unset.code).toBe(1);
    expect(unset.stderr).toContain('--pass-env Z0_ENV_DUMP_DIR');
    const lacking = await regrade(c, [], { CLAUDE_CODE_OAUTH_TOKEN: undefined });
    expect(lacking.code).toBe(1);
    expect(lacking.stderr).toContain('had CLAUDE_CODE_OAUTH_TOKEN');
    expect(rowsOf(c.out)).toEqual([]);
  }, 300_000);

  it('finds a cell\'s env record by sequence, not run name, and compares env keys case-blind on win32 (R27)', async () => {
    const c = copyOut(shared);
    renameSync(join(c.out, 'grading', 'seqF'), join(c.out, 'grading', 'seqF-r2'));
    for (const id of ['t1', 't2', 'n1', 'a1', 't3', 'a2', 'a3', 'a4']) {
      const file = join(c.out, 'grading', 'seqF-r2', 'A0', 'seed1', `${id}.grade.json`);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), runName: 'seqF-r2' }));
    }
    expect(await regrade(c, ['--cell', keyOf('t1')])).toMatchObject({ code: 0, stderr: '' });
    const runs = join(c.out, 'runs.jsonl');
    const swap = (k: string) => (k.toUpperCase() === 'PATH' ? (k === 'PATH' ? 'Path' : 'PATH') : k);
    const lines = readFileSync(runs, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    writeFileSync(runs, lines.map((r) => `${JSON.stringify(Array.isArray(r.envKeys) ? { ...r, envKeys: r.envKeys.map(swap) } : r)}\n`).join(''));
    expect((await regrade(c, ['--cell', keyOf('t2')])).code).toBe(process.platform === 'win32' ? 0 : 1);
  }, 300_000);

  it('a test command that flips counts in acceptanceFlips and drops no lesson (11)', async () => {
    const c = copyOut(shared);
    expect(await regrade(c, [], { Z0_TOGGLE_TEST: 'regrade' })).toMatchObject({ code: 0 });
    expect(rowFor(c.out, 'a1').acceptance).toEqual({ saved: true, regraded: false, flip: true, reason: 'verdict' });
    expect(await grading(c.out)).toMatchObject({ code: 0 });
    expect(readGrading(c.out)).toMatchObject({ flippedLessons: [], acceptanceFlips: 1, g5: { extraEnvKeys: ['Z0_TOGGLE_TEST'] } });
  }, 300_000);

  it('a resumed teach re-runs its final check; an apply that passed first is checked once (12)', async () => {
    const c = copyOut(shared);
    const count = async (id: string) => {
      const before = dumpsIn(shared.dumps).length;
      expect(await regrade(c, ['--cell', keyOf(id)])).toMatchObject({ code: 0 });
      return dumpsIn(shared.dumps).length - before;
    };
    expect(gradeOf(c.out, 't2').finalChecked).toBe(true);
    expect(await count('t2')).toBe(2);
    expect(gradeOf(c.out, 'a2').finalChecked).toBe(false);
    expect(await count('a2')).toBe(1);
    expect(rowFor(c.out, 'a2').checks.map((x) => [x.which, x.regraded])).toEqual([['first', 'pass'], ['final', 'pass']]);
  }, 300_000);

  it('a stale-check flip drops the superseded lesson and not the main one (R10)', async () => {
    const c = copyOut(shared);
    expect(await regrade(c, ['--cell', keyOf('a4')], { Z0_TOGGLE: 'regrade' })).toMatchObject({ code: 0 });
    const flips = rowFor(c.out, 'a4').checks.filter((x) => x.flip);
    expect(flips).toEqual([expect.objectContaining({ lessonId: 'f1-l1', which: 'stale', saved: true, regraded: false, reason: 'verdict' })]);
  }, 300_000);
});
