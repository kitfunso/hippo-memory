// Z0 G5 regrade (prereg 166): resuming, idempotence, the lock, the evidence guard, tree checks and the post-fix pass.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanup, tmp } from './fixtures/z0-harness.js';
import { PRICES } from './fixtures/z0-gen.js';
import { copyOut, grading, keyOf, lessonOf, readGrading, regrade, rowFor, rowsOf, sharedRun, taskOf, type RawSpec, type Shared } from './fixtures/z0-regrade.js';
import { evidenceOf } from '../scripts/token-eval/regrade.mjs';
import { parseZ0Records } from '../scripts/token-eval/z0-records.mjs';
import { runCli as analyze } from '../scripts/token-eval/z0-analyze.mjs';

const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
let shared: Shared;
const rowsText = (out: string) => readFileSync(join(out, 'g5', 'regrade.jsonl'), 'utf8');
const node = (js: string) => `node -e "${js}"`;
const setupAll = (js: string) => (s: RawSpec) => {
  for (const t of s.sequences[0].tasks) t.setup = node(js);
};
const records = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('z0-regrade resume, guards and post-fix', () => {
  beforeAll(async () => {
    shared = await sharedRun('regrade-resume');
  }, 600_000);
  afterAll(() => {
    cleanup();
    if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
  });

  it('a cut-off regrade resumes: done cells are skipped, a torn last line is dropped once, a third run adds nothing (13, R8)', async () => {
    const c = copyOut(shared);
    expect(await regrade(c, ['--cell', keyOf('t1'), '--cell', keyOf('t2'), '--cell', keyOf('n1')])).toMatchObject({ code: 0 });
    appendFileSync(join(c.out, 'g5', 'regrade.jsonl'), '{"schema":"z0-regrade/1","key":"seqF#1@3/A0"');
    const second = await regrade(c);
    expect(second).toMatchObject({ code: 0, stdout: 'repro: regraded 5 cells (0 with errors), skipped 3 done ones\n' });
    expect(second.stderr.match(/torn last line/g)).toHaveLength(1);
    const text = rowsText(c.out);
    expect(text.endsWith('\n')).toBe(true);
    expect(rowsOf(c.out).map((r) => r.key)).toEqual(['t1', 't2', 'n1', 'a1', 't3', 'a2', 'a3', 'a4'].map(keyOf));
    const third = await regrade(c);
    expect(third).toMatchObject({ code: 0, stderr: '', stdout: 'repro: regraded 0 cells (0 with errors), skipped 8 done ones\n' });
    expect(rowsText(c.out)).toBe(text);
  }, 300_000);

  it('regrade and grading twice give byte-identical grading.json and no new rows (14)', async () => {
    const c = copyOut(shared);
    expect(await regrade(c, [], { Z0_TOGGLE: 'regrade' })).toMatchObject({ code: 0 });
    expect(await grading(c.out)).toMatchObject({ code: 0 });
    const [rows, file] = [rowsText(c.out), readFileSync(join(c.out, 'grading.json'))];
    expect(await regrade(c, [], { Z0_TOGGLE: 'regrade' })).toMatchObject({ code: 0, stdout: expect.stringContaining('regraded 0 cells') });
    expect(await grading(c.out)).toMatchObject({ code: 0 });
    expect(rowsText(c.out)).toBe(rows);
    expect(readFileSync(join(c.out, 'grading.json')).equals(file)).toBe(true);
  }, 300_000);

  it('an edited grade.json re-runs its cell; a changed checker is checker-changed, which grading refuses until --flip-errors (15)', async () => {
    const c = copyOut(shared);
    expect(await regrade(c)).toMatchObject({ code: 0 });
    const file = join(c.out, 'grading', 'seqF', 'A0', 'seed1', 'a2.grade.json');
    writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, 'utf8')), null, 1));
    expect(await regrade(c)).toMatchObject({ code: 0, stdout: 'repro: regraded 1 cells (0 with errors), skipped 7 done ones\n' });
    expect(rowsOf(c.out).at(-1)!.key).toBe(keyOf('a2'));

    // The checker's args and the hidden tests' fixRef and file list are inputs too: a change re-runs the cells that use them.
    const raw: RawSpec = JSON.parse(readFileSync(c.tasks, 'utf8'));
    lessonOf(raw, 'f1-l1').check.args = ['--strict'];
    taskOf(raw, 'a2').fixRef = `${taskOf(raw, 'a2').fixRef}^{commit}`;
    taskOf(raw, 'n1').testFiles = [...taskOf(raw, 'n1').testFiles, ...taskOf(raw, 'n1').testFiles];
    writeFileSync(c.tasks, JSON.stringify(raw));
    expect(await regrade(c)).toMatchObject({ code: 0, stdout: 'repro: regraded 5 cells (0 with errors), skipped 3 done ones\n' });

    raw.families[0].lessons[0].check.script = join(dirname(raw.families[0].lessons[0].check.script), 'crash-on-toggle.mjs');
    writeFileSync(c.tasks, JSON.stringify(raw));
    expect(await regrade(c)).toMatchObject({ code: 0, stdout: 'repro: regraded 3 cells (3 with errors), skipped 5 done ones\n' });
    for (const id of ['t1', 'a1', 'a4']) expect(rowFor(c.out, id)).toMatchObject({ status: 'error', error: { stage: 'checker-changed' } });
    const refused = await grading(c.out);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`${keyOf('a1')} (repro, checker-changed)`);
    expect(await grading(c.out, ['--flip-errors'])).toMatchObject({ code: 0 });
    expect(readGrading(c.out)).toMatchObject({ flippedLessons: ['f1-l1', 'f1-l2'], acceptanceFlips: 3, g5: { unreproducible: { cells: 3, lessons: ['f1-l1', 'f1-l2'] } } });
  }, 300_000);

  it('a held lock is refused by name; a regrade that throws still removes its own lock (16)', async () => {
    const c = copyOut(shared);
    const lock = join(c.out, 'g5', 'regrade.lock');
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, '1\n');
    const held = await regrade(c);
    expect(held.code).toBe(1);
    expect(held.stderr).toContain('regrade.lock exists');
    expect((await grading(c.out)).stderr).toContain('regrade.lock exists');
    expect(rowsOf(c.out)).toEqual([]);
    rmSync(lock);
    const thrown = await regrade(c, ['--cell', 'seqF#1@99/A0']);
    expect(thrown).toMatchObject({ code: 1, stderr: expect.stringContaining('no such cell') });
    expect(existsSync(lock)).toBe(false);
  }, 300_000);

  it('a setup that writes to the homes leaves the run root, work/ included, byte for byte unchanged (17, R22)', async () => {
    const c = copyOut(shared, setupAll("const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(process.env.CLAUDE_CONFIG_DIR,'x.txt'),'1');fs.writeFileSync(p.join(process.env.HIPPO_HOME,'y.txt'),'1')"));
    const root = join(c.out, 'runs');
    const before = evidenceOf(root);
    expect(await regrade(c, ['--cell', keyOf('t1'), '--cell', keyOf('a1')])).toMatchObject({ code: 0 });
    expect(rowsOf(c.out).map((r) => r.status)).toEqual(['done', 'done']);
    expect(evidenceOf(root)).toEqual(before);
    expect(existsSync(join(c.out, 'rg', 'seqF', 'A0', 'seed1', 'claude-config', 'x.txt'))).toBe(true);
    expect(existsSync(join(c.out, 'rg', 'seqF', 'A0', 'seed1', 'hippo-home', 'y.txt'))).toBe(true);
  }, 300_000);

  it('a cell that writes under the run root stops the whole regrade, names the cell and the path, and leaves no lock (R23)', async () => {
    const c = copyOut(shared);
    // The target names the copy's own run root, so the setup goes in once the copy exists.
    const target = join(c.out, 'runs', 'seqF', 'A0', 'seed1', 'evil.txt').replaceAll('\\', '/');
    const raw: RawSpec = JSON.parse(readFileSync(c.tasks, 'utf8'));
    taskOf(raw, 'a1').setup = node(`require('fs').writeFileSync('${target}','x')`);
    writeFileSync(c.tasks, JSON.stringify(raw));
    const r = await regrade(c);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`regrading cell ${keyOf('a1')} changed the run's evidence`);
    expect(r.stderr).toContain('evil.txt');
    expect(rowsOf(c.out).map((x) => x.key)).toEqual(['t1', 't2', 'n1'].map(keyOf));
    expect(existsSync(join(c.out, 'g5', 'regrade.lock'))).toBe(false);
  }, 300_000);

  it('a setup that makes a nested repo fails verifyTree as an error row; a stray untracked file is cleaned and still matches (18)', async () => {
    const nested = copyOut(shared, (s) => {
      taskOf(s, 'a1').setup = 'git init -q nested && git -C nested -c user.email=a@b.c -c user.name=a -c commit.gpgsign=false commit -q --allow-empty -m x';
    });
    expect(await regrade(nested, ['--cell', keyOf('a1')])).toMatchObject({ code: 0 });
    expect(rowFor(nested.out, 'a1')).toMatchObject({ status: 'error', error: { stage: 'tree' } });
    const stray = copyOut(shared, (s) => {
      taskOf(s, 'a1').setup = node("require('fs').writeFileSync('stray.txt','x')");
    });
    expect(await regrade(stray, ['--cell', keyOf('a1')])).toMatchObject({ code: 0 });
    expect(rowFor(stray.out, 'a1')).toMatchObject({ status: 'done' });
  }, 300_000);

  // A repro pass plus a post-fix pass that runs every check twice: about three regrades, slow on a loaded Windows box.
  it('flippedLessons is the union of the repro and post-fix passes (19)', async () => {
    const c = copyOut(shared);
    expect(await regrade(c, [], { Z0_TOGGLE: 'regrade' })).toMatchObject({ code: 0 });
    expect(await regrade(c, ['--post-fix'])).toMatchObject({ code: 0, stdout: expect.stringContaining('wrote ') });
    expect(rowsOf(c.out, 'postfix').flatMap((r) => r.checks).filter((x) => x.flip)).toEqual([]);
    expect(rowFor(c.out, 'a1', 'postfix').checks[0]).toMatchObject({ regraded: 'pass', second: 'pass' });
    expect(await grading(c.out)).toMatchObject({ code: 0 });
    expect(readGrading(c.out)).toMatchObject({ flippedLessons: ['f1-l1'], g5: { pass: 'postfix' } });
  }, 600_000);

  it('under --post-fix, a checker that did not change flips when its verdict differs from the saved one (R2)', async () => {
    const c = copyOut(shared);
    expect(await regrade(c, ['--post-fix', '--cell', keyOf('a1')], { Z0_TOGGLE: 'regrade' })).toMatchObject({ code: 0 });
    expect(rowFor(c.out, 'a1', 'postfix').checks[0]).toMatchObject({ saved: 'pass', regraded: 'fail', second: 'fail', flip: true, reason: 'verdict' });
  }, 300_000);

  it('a flip that a re-run of its cell does not repeat still drops the lesson (R7)', async () => {
    const c = copyOut(shared);
    expect(await regrade(c, ['--cell', keyOf('a1')], { Z0_TOGGLE: 'regrade' })).toMatchObject({ code: 0 });
    expect(rowFor(c.out, 'a1').checks[0]).toMatchObject({ flip: true });
    const file = join(c.out, 'grading', 'seqF', 'A0', 'seed1', 'a1.grade.json');
    writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, 'utf8')), null, 1));
    expect(await regrade(c)).toMatchObject({ code: 0, stdout: 'repro: regraded 8 cells (0 with errors), skipped 0 done ones\n' });
    expect(rowFor(c.out, 'a1').checks.some((x) => x.flip)).toBe(false);
    expect(await grading(c.out)).toMatchObject({ code: 0 });
    expect(readGrading(c.out)).toMatchObject({ flippedLessons: ['f1-l1'] });
  }, 300_000);

  it('a late harness fault keeps the checks that ran before it, and their flips count after a clean retry (R7)', async () => {
    const c = copyOut(shared);
    // t1's checker spoils .git during its first check, so the final check's checkout fails with that flip already seen.
    expect(await regrade(c, ['--cell', keyOf('t1')], { Z0_TOGGLE: 'regrade', Z0_TOGGLE_BREAK_GIT: '1' })).toMatchObject({ code: 0 });
    expect(rowFor(c.out, 't1')).toMatchObject({ status: 'error', error: { stage: 'git' }, checks: [expect.objectContaining({ which: 'first', saved: 'pass', regraded: 'fail', flip: true })] });
    expect(await regrade(c)).toMatchObject({ code: 0, stdout: 'repro: regraded 8 cells (0 with errors), skipped 0 done ones\n' });
    expect(rowFor(c.out, 't1')).toMatchObject({ status: 'done' });
    expect(await grading(c.out)).toMatchObject({ code: 0 });
    expect(readGrading(c.out)).toMatchObject({ flippedLessons: ['f1-l1'], g5: { unreproducible: { cells: 0 } } });
  }, 300_000);

  it('a valid record with no grade.json refuses the regrade, and a regraded cell whose grade.json is gone refuses grading (166)', async () => {
    const c = copyOut(shared);
    expect(await regrade(c)).toMatchObject({ code: 0 });
    rmSync(join(c.out, 'grading', 'seqF', 'A0', 'seed1', 'a2.grade.json'));
    const graded = await grading(c.out);
    expect(graded.code).toBe(1);
    expect(graded.stderr).toContain(`${keyOf('a2')} has regrade rows but no grade.json`);
    const again = await regrade(c);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain(`no grade.json for 1 valid cells in runs.jsonl: ${keyOf('a2')}`);
  }, 300_000);

  it('runs.regraded.jsonl takes new verdicts, recomputes resolved and chain.followed, keeps acceptancePassed, and shares the blind key (19, 20, R3)', async () => {
    const c = copyOut(shared);
    const env = { Z0_TOGGLE: 'regrade', Z0_TOGGLE_TEST: 'regrade' };
    expect(await regrade(c, [], env)).toMatchObject({ code: 0 });
    // The fixed checker: new bytes, so its post-fix verdicts may move from the saved ones without a flip.
    const raw: RawSpec = JSON.parse(readFileSync(c.tasks, 'utf8'));
    const { check } = lessonOf(raw, 'f1-l1');
    const fixed = join(tmp('z0-rg-fix-'), 'toggle-fixed.mjs');
    writeFileSync(fixed, `${readFileSync(check.script, 'utf8')}// fixed\n`);
    check.script = fixed;
    writeFileSync(c.tasks, JSON.stringify(raw));
    expect(await regrade(c, ['--post-fix'], env)).toMatchObject({ code: 0 });
    const file = join(c.out, 'runs.regraded.jsonl');
    expect(() => parseZ0Records(readFileSync(file, 'utf8'), file)).not.toThrow();
    const [before, after] = [records(join(c.out, 'runs.jsonl')), records(file)];
    const pick = (rs: ReturnType<typeof records>, id: string) => rs.find((r) => r.taskId === id);
    expect(pick(before, 'a1')).toMatchObject({ acceptancePassed: true, resolved: true, lessons: [{ first: 'pass', final: 'pass' }], chain: { shown: true, followed: true } });
    expect(pick(after, 'a1')).toMatchObject({ acceptancePassed: true, resolved: false, lessons: [{ first: 'fail', final: 'fail' }], chain: { shown: true, followed: false } });
    expect(rowFor(c.out, 'a1', 'postfix').acceptance).toMatchObject({ saved: true, regraded: false, flip: true });
    // A changed checker's verdict that differs from the saved one is the fix working; only its two runs disagreeing flip.
    expect(rowFor(c.out, 'a1', 'postfix').checks[0]).toMatchObject({ saved: 'pass', regraded: 'fail', second: 'fail', flip: false });
    expect(pick(after, 'a4').lessons[0]).toMatchObject({ first: 'pass', staleFollow: false });
    expect(pick(after, 'n1')).toEqual(pick(before, 'n1'));
    expect(after).toHaveLength(before.length);

    // The analyzer's default key path is beside the first --runs file, so both files find the same key.
    writeFileSync(join(c.out, 'prices.json'), JSON.stringify(PRICES));
    const args = (runs: string) => ['--runs', runs, '--plan', 'plan.json', '--prices', 'prices.json'];
    expect(analyze(args('runs.jsonl'), c.out).code).toBe(0);
    const key = readFileSync(join(c.out, 'z0-blind-key.json'), 'utf8');
    expect(analyze(args('runs.regraded.jsonl'), c.out).code).toBe(0);
    expect(readFileSync(join(c.out, 'z0-blind-key.json'), 'utf8')).toBe(key);
  }, 600_000);
});
