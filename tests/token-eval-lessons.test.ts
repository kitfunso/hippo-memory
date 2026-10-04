// Z0 lesson families: tasks-file validation, the per-seed order, roles, teach messages and checker verdicts.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error - .mjs script without a .d.ts
import { validateFamilies, drawOrder, taskRoles, teachMessage, memoryText, wordOverlap, promptLeaks, withTaught } from '../scripts/token-eval/lessons.mjs';
// @ts-expect-error - .mjs script without a .d.ts
import { runCheck, CheckerError } from '../scripts/token-eval/checks.mjs';
// @ts-expect-error - .mjs script without a .d.ts
import { validateTasks } from '../scripts/token-eval/ab-run.mjs';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

interface Task { id: string; kind?: string; familyId?: string; lessonId?: string; prompt: string; keyPhraseAllowed?: boolean; [k: string]: string | boolean | string[] | undefined }

/** A dir holding checks/lesson.mjs, which exits with its first argument. */
function checkDir(): string {
  const d = tmp('z0-lessons-');
  mkdirSync(join(d, 'checks'));
  writeFileSync(join(d, 'checks', 'lesson.mjs'), 'process.exit(Number(process.argv[2] ?? 0));\n');
  return d;
}

const t = (id: string, kind: string, extra: Partial<Task> = {}): Task => ({ id, kind, baseRef: 'b', fixRef: 'f', prompt: `do ${id}`, test: 'node test.js', testFiles: [], ...extra });
const teach = (id: string, familyId: string, lessonId: string, extra: Partial<Task> = {}) => t(id, 'teach', { familyId, lessonId, ...extra });
const apply = (id: string, familyId: string, lessonId: string, extra: Partial<Task> = {}) => t(id, 'apply', { familyId, lessonId, ...extra });
interface Lesson { id: string; rule: string; reason: string; keyPhrase: string; check: { script: string }; supersedes?: string }
const lesson = (id: string, rule: string, keyPhrase: string, extra: { supersedes?: string } = {}): Lesson => ({ id, rule, reason: 'the release script reads them', keyPhrase, check: { script: 'checks/lesson.mjs' }, ...extra });
const SCREEN = { id: 'screen', baseRef: 'b', fixRef: 'f', prompt: 'screen task', test: 'node test.js', testFiles: [] };

/** Two families on one sequence: f1 with a reversal (l1 then l2), f2 plain; four no-lesson tasks. */
interface Family { id: string; sequence: string; lessonSource: string; screen?: typeof SCREEN; lessons: Lesson[] }
interface Spec { families: Family[]; sequences: Array<{ id: string; cluster: string; repo: string; fixedOrder: boolean; tasks: Task[] }>; dev?: boolean }
function spec(fixedOrder = false): Spec {
  return {
    families: [
      { id: 'f1', sequence: 'seqA', lessonSource: 'maintainer', screen: { ...SCREEN, id: 'f1-screen' }, lessons: [
        lesson('f1-l1', 'Changelog entries go in changelog.d fragments', 'changelog.d'),
        lesson('f1-l2', 'Changelog entries go in NEWS.md now', 'NEWS.md', { supersedes: 'f1-l1' }),
      ] },
      { id: 'f2', sequence: 'seqA', lessonSource: 'template', screen: { ...SCREEN, id: 'f2-screen' }, lessons: [lesson('f2-l1', 'Log through the repo logger, never console', 'logger')] },
    ],
    sequences: [{ id: 'seqA', cluster: 'c', repo: 'r', fixedOrder, tasks: [
      teach('t1', 'f1', 'f1-l1'), t('n1', 'no-lesson'), t('n2', 'no-lesson'), apply('a1', 'f1', 'f1-l1'), apply('a2', 'f1', 'f1-l1'),
      teach('t2', 'f1', 'f1-l2'), teach('t3', 'f2', 'f2-l1'), t('n3', 'no-lesson'), apply('a3', 'f1', 'f1-l2'), t('n4', 'no-lesson'),
      apply('a4', 'f2', 'f2-l1'), apply('a5', 'f2', 'f2-l1'),
    ] }],
  };
}

describe('validateFamilies', () => {
  it('accepts a valid two-family file with a reversal and stores each checker path', () => {
    const dir = checkDir();
    const s = spec();
    expect(() => validateFamilies(s, dir)).not.toThrow();
    expect(s.families[0].lessons[0]).toMatchObject({ checkPath: join(dir, 'checks', 'lesson.mjs') });
  });

  const rejects: Array<[string, (s: Spec) => void, RegExp]> = [
    ['no kind', (s) => { delete s.sequences[0].tasks[1].kind; }, /task n1.*kind/],
    ['unknown kind', (s) => { s.sequences[0].tasks[1].kind = 'screen'; }, /task n1.*kind/],
    ['family on a no-lesson task', (s) => { s.sequences[0].tasks[1].familyId = 'f1'; }, /task n1.*no-lesson/],
    ['teach without a lesson', (s) => { delete s.sequences[0].tasks[0].lessonId; }, /task t1.*familyId and lessonId/],
    ['unknown family', (s) => { s.sequences[0].tasks[0].familyId = 'f9'; }, /task t1.*unknown family f9/],
    ['unknown lesson', (s) => { s.sequences[0].tasks[3].lessonId = 'f1-l9'; }, /task a1.*no lesson f1-l9/],
    ['family in two sequences', (s) => { s.sequences.push({ id: 'seqB', cluster: 'c', repo: 'r', fixedOrder: false, tasks: [apply('b1', 'f2', 'f2-l1'), t('b2', 'no-lesson')] }); }, /family f2.*one sequence/],
    ['family sequence disagrees', (s) => { s.families[1].sequence = 'seqZ'; }, /family f2.*seqZ/],
    ['two teach tasks', (s) => { s.sequences[0].tasks[1] = teach('n1', 'f2', 'f2-l1'); }, /lesson f2-l1.*exactly one teach task/],
    ['no root lesson', (s) => { s.families[0].lessons[0].supersedes = 'f1-l2'; }, /family f1.*one root lesson/],
    ['two root lessons', (s) => { delete s.families[0].lessons[1].supersedes; }, /family f1.*one root lesson/],
    ['chain of two reversals', (s) => { s.families[0].lessons.push(lesson('f1-l3', 'Changelog entries go in HISTORY', 'HISTORY', { supersedes: 'f1-l2' })); }, /family f1.*one reversal/],
    ['one apply in a family', (s) => { s.sequences[0].tasks[11] = t('a5', 'no-lesson'); }, /family f2.*at least 2 apply tasks/],
    ['lesson without an apply', (s) => { s.sequences[0].tasks[8] = t('a3', 'no-lesson'); }, /lesson f1-l2.*no apply task/],
    ['bad lessonSource', (s) => { s.families[0].lessonSource = 'mined'; }, /family f1.*lessonSource/],
    ['missing reason', (s) => { s.families[0].lessons[0].reason = ''; }, /lesson f1-l1.*reason/],
    ['missing checker', (s) => { s.families[0].lessons[0].check = { script: '' }; }, /lesson f1-l1.*check\.script/],
    ['checker not on disk', (s) => { s.families[0].lessons[0].check = { script: 'checks/none.mjs' }; }, /lesson f1-l1.*checks[/\\]none\.mjs/],
    ['rule says remember', (s) => { s.families[0].lessons[0].rule = 'Remember to use changelog.d'; }, /lesson f1-l1.*remember/i],
    ['reason names CLAUDE.md', (s) => { s.families[0].lessons[0].reason = 'CLAUDE.md says so'; }, /lesson f1-l1/],
    ['rule names hippo', (s) => { s.families[0].lessons[0].rule = 'Ask hippo first'; }, /lesson f1-l1/],
    ['apply prompt holds the key phrase', (s) => { s.sequences[0].tasks[3].prompt = 'add a Changelog.D entry'; }, /task a1.*key phrase/],
    ['family without a screen task', (s) => { delete s.families[1].screen; }, /family f2.*screen/],
    ['screenSkipped outside a dev file', (s) => { delete s.families[1].screen; Object.assign(s.families[1], { screenSkipped: true, screenNote: 'toy' }); }, /family f2.*"dev": true/],
    ['set X task', (s) => { s.sequences[0].tasks[1].set = 'X'; }, /set X needs the Codex runner/],
  ];
  for (const [name, mutate, re] of rejects) {
    it(`rejects ${name}, naming it`, () => {
      const s: Spec = spec();
      mutate(s);
      expect(() => validateFamilies(s, checkDir())).toThrow(re);
    });
  }

  it('keeps the plain word memory legal, allows a flagged key phrase, and accepts screenSkipped in a dev file', () => {
    const s: Spec = spec();
    s.families[0].lessons[0].rule = 'Free memory with the arena allocator';
    s.sequences[0].tasks[3] = { ...s.sequences[0].tasks[3], prompt: 'write changelog.d entry', keyPhraseAllowed: true };
    delete s.families[1].screen;
    Object.assign(s.families[1], { screenSkipped: true, screenNote: 'toy family' });
    s.dev = true;
    expect(() => validateFamilies(s, checkDir())).not.toThrow();
  });

  it('a no-lesson file needs no families and no base dir', () => {
    expect(() => validateTasks({ sequences: [{ id: 's', cluster: 'c', repo: 'r', tasks: [t('x', 'no-lesson'), t('y', 'no-lesson')] }] })).not.toThrow();
  });

  it('a real run refuses a dev file; a dry run takes it', () => {
    const dir = checkDir();
    const s: Spec = spec();
    delete s.families[1].screen;
    Object.assign(s.families[1], { screenSkipped: true, screenNote: 'toy family' });
    s.dev = true;
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify(s));
    const cli = (...extra: string[]) => spawnSync(process.execPath, [join(__dirname, '..', 'scripts', 'token-eval', 'ab-run.mjs'), '--tasks', file, '--out', join(dir, 'out'), ...extra], { encoding: 'utf8', env: { ...process.env, Z0_ANCESTOR_STOP: dir } });
    const real = cli();
    expect(real.status).not.toBe(0);
    expect(real.stderr).toMatch(/"dev": true.*real run/);
    const dry = cli('--dry-run');
    expect(dry.status, dry.stderr).toBe(0);
  });
});

const families = () => spec().families;
const positions = (order: string[]) => new Map(order.map((id, i) => [id, i]));

/** Every hard rule of prereg 117-119 on one drawn order of spec(). */
function meetsRules(order: string[]) {
  const at = positions(order);
  const p = (id: string) => at.get(id)!;
  expect(order.slice().sort()).toEqual(spec().sequences[0].tasks.map((x) => x.id).sort());
  expect(Math.min(p('a1'), p('a2')) - p('t1') - 1).toBeGreaterThanOrEqual(2);
  expect(p('a3') - p('t2') - 1).toBeGreaterThanOrEqual(2);
  expect(Math.min(p('a4'), p('a5')) - p('t3') - 1).toBeGreaterThanOrEqual(2);
  expect(p('t2')).toBeGreaterThan(Math.max(p('a1'), p('a2')));
}

describe('drawOrder', () => {
  const seq = () => spec().sequences[0];
  const byId = (ids: string[]) => ids.map((id) => seq().tasks.find((x) => x.id === id)!);

  it('meets every spacing rule with no prompt leak on 50 seeds, same seed same order, seeds differ', () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 50; seed++) {
      const order = drawOrder(seq(), families(), seed);
      meetsRules(order);
      expect(promptLeaks(byId(order), families())).toEqual([]);
      expect(drawOrder(seq(), families(), seed)).toEqual(order);
      orders.add(order.join(','));
    }
    expect(drawOrder(seq(), families(), 1)).not.toEqual(drawOrder(seq(), families(), 2));
    expect(orders.size).toBeGreaterThan(10);
  });

  it('errors on an unsatisfiable sequence, naming it and the constraint', () => {
    const s = { id: 'seqU', fixedOrder: false, tasks: [teach('t1', 'f2', 'f2-l1'), apply('a4', 'f2', 'f2-l1'), apply('a5', 'f2', 'f2-l1'), t('n1', 'no-lesson')] };
    expect(() => drawOrder(s, families(), 1)).toThrow(/seqU.*fewer than 2 tasks between the teach task of lesson f2-l1/);
  });

  it('fixedOrder returns the file order and errors on a broken constraint', () => {
    expect(drawOrder({ ...seq(), fixedOrder: true }, families(), 7)).toEqual(seq().tasks.map((x) => x.id));
    const broken = { ...seq(), fixedOrder: true, tasks: [teach('t3', 'f2', 'f2-l1'), t('n1', 'no-lesson'), apply('a4', 'f2', 'f2-l1'), apply('a5', 'f2', 'f2-l1')] };
    expect(() => drawOrder(broken, families(), 1)).toThrow(/seqA.*fewer than 2 tasks between.*a4/);
    const stale = { ...seq(), fixedOrder: true, tasks: seq().tasks.filter((x) => x.id !== 'a2').concat([apply('a2', 'f1', 'f1-l1')]) };
    expect(() => drawOrder(stale, families(), 1)).toThrow(/seqA.*a2.*f1-l1/);
  });

  it('never draws a no-lesson prompt holding a key phrase before its teach task', () => {
    const leaky = { ...seq(), tasks: seq().tasks.map((x) => (x.id === 'n4' ? { ...x, prompt: 'tidy the LOGGER setup' } : x)) };
    for (let seed = 1; seed <= 50; seed++) {
      const at = positions(drawOrder(leaky, families(), seed));
      expect(at.get('n4')!).toBeGreaterThan(at.get('t3')!);
    }
    const fixed = { ...leaky, fixedOrder: true, tasks: [leaky.tasks[9], ...leaky.tasks.filter((x) => x.id !== 'n4')] };
    expect(() => drawOrder(fixed, families(), 1)).toThrow(/task n4.*lesson f2-l1/);
  });

  it('keyPhraseAllowed exempts only the task\'s own lesson: a pre-reversal apply naming the reversal still leaks', () => {
    const tasks = seq().tasks.map((x) => (x.id === 'a1' ? { ...x, prompt: 'move the changelog.d entry to NEWS.md', keyPhraseAllowed: true } : x));
    expect(() => validateFamilies({ ...spec(), sequences: [{ ...seq(), tasks }] }, checkDir())).not.toThrow();
    expect(promptLeaks(tasks, families())).toEqual([{ taskId: 'a1', lessonId: 'f1-l2' }]);
    expect(() => drawOrder({ ...seq(), tasks }, families(), 1)).toThrow(/seqA.*task a1.*lesson f1-l2/);
    // Placed ahead of its own teach, the flagged apply is still no leak of its own lesson.
    const own = { ...seq().tasks.find((x) => x.id === 'a1')!, prompt: 'add a changelog.d entry', keyPhraseAllowed: true };
    expect(promptLeaks([own, ...seq().tasks.filter((x) => x.id !== 'a1')], families())).toEqual([]);
  });

  it('names the task and lesson of a leak no draw can avoid', () => {
    const leaky = { ...seq(), tasks: seq().tasks.map((x) => (x.id === 'a1' ? { ...x, prompt: 'add the line to NEWS.md' } : x)) };
    expect(() => drawOrder(leaky, families(), 1)).toThrow(/seqA.*task a1.*lesson f1-l2/);
  });
});

describe('taskRoles', () => {
  it('gives apply roles on a hand-built order, null role fields elsewhere', () => {
    const s = spec().sequences[0];
    const ids = ['t1', 'n1', 'n2', 'a1', 't3', 'a2', 'n3', 't2', 'a4', 'n4', 'a3', 'a5'];
    const roles = taskRoles(ids.map((id) => s.tasks.find((x) => x.id === id)!), families());
    const get = (id: string) => roles[ids.indexOf(id)];
    expect(get('a1')).toMatchObject({ kind: 'apply', familyId: 'f1', lessonId: 'f1-l1', lessonSource: 'maintainer', applyIndex: 1, afterReversal: false, tasksSinceTeach: 2, set: 'R' });
    expect(get('a2')).toMatchObject({ applyIndex: 2, afterReversal: false, tasksSinceTeach: 4 });
    expect(get('a3')).toMatchObject({ lessonId: 'f1-l2', applyIndex: 3, afterReversal: true, tasksSinceTeach: 2 });
    expect(get('a4')).toMatchObject({ familyId: 'f2', lessonSource: 'template', applyIndex: 1, afterReversal: false, tasksSinceTeach: 3 });
    expect(get('a5')).toMatchObject({ applyIndex: 2, tasksSinceTeach: 6 });
    for (const id of ['t1', 't2', 't3']) expect(get(id)).toMatchObject({ kind: 'teach', applyIndex: null, afterReversal: null, tasksSinceTeach: null, set: 'R' });
    expect(get('t2')).toMatchObject({ lessonId: 'f1-l2', familyId: 'f1' });
    for (const id of ['n1', 'n4']) expect(get(id)).toEqual({ kind: 'no-lesson', familyId: null, lessonId: null, lessonSource: null, applyIndex: null, afterReversal: null, tasksSinceTeach: null, set: 'N' });
  });
});

describe('teach messages and A4 memory', () => {
  const l = { id: 'x', rule: 'Changelog entries go in changelog.d fragments', reason: 'the release script builds CHANGELOG from them' };

  it('builds the fixed templates from the rule and reason only', () => {
    expect(teachMessage(l, 'correction')).toBe('No: Changelog entries go in changelog.d fragments, because the release script builds CHANGELOG from them. Please fix it.');
    expect(teachMessage(l, 'confirmation')).toBe('Yes, keep doing that: Changelog entries go in changelog.d fragments, because the release script builds CHANGELOG from them.');
    expect(() => teachMessage(l, 'other')).toThrow(/form/);
  });

  it('A4 memory is a blank line then one line per taught lesson, and a reversal replaces its lesson', () => {
    expect(memoryText([])).toBe('');
    const l2 = { id: 'y', supersedes: 'x', rule: 'Use NEWS.md', reason: 'fragments were retired' };
    const l3 = { id: 'z', rule: 'Log through the logger', reason: 'console output is dropped' };
    expect(memoryText(withTaught(withTaught([], l), l3))).toBe(`\n- ${l.rule}, because ${l.reason}.\n- ${l3.rule}, because ${l3.reason}.\n`);
    expect(withTaught(withTaught(withTaught([], l), l3), l2).map((x: { id: string }) => x.id)).toEqual(['z', 'y']);
  });

  it('word overlap is the share of the rule content words found in the prompt', () => {
    expect(wordOverlap('Fix the release notes in the fragments folder', 'Changelog entries go in changelog.d fragments')).toBeCloseTo(1 / 3);
    expect(wordOverlap('nothing shared', 'Changelog entries go in fragments')).toBe(0);
    expect(wordOverlap('anything', 'go in it')).toBe(0);
  });
});

describe('runCheck verdicts', () => {
  const check = (args: string[], timeoutMs?: number) => {
    const dir = checkDir();
    const l = { id: 'l', check: { script: 'checks/lesson.mjs', args }, checkPath: join(dir, 'checks', 'lesson.mjs') };
    return runCheck(l, { work: dir, env: process.env, preCommit: 'p', postCommit: 'q', commands: [], scratch: join(dir, 'scratch'), timeoutMs });
  };

  it('maps exit 0, 1 and 3 to pass, fail and na', () => {
    expect(check(['0'])).toBe('pass');
    expect(check(['1'])).toBe('fail');
    expect(check(['3'])).toBe('na');
  });

  it('runs the checker with no system or global git config', () => {
    const dir = checkDir();
    writeFileSync(join(dir, 'checks', 'env.mjs'), "process.exit(process.env.GIT_CONFIG_NOSYSTEM === '1' && process.env.GIT_CONFIG_GLOBAL === '/dev/null' ? 0 : 1);\n");
    const l = { id: 'e', check: { script: 'checks/env.mjs' }, checkPath: join(dir, 'checks', 'env.mjs') };
    const env = { ...process.env, GIT_CONFIG_GLOBAL: join(dir, 'agent-gitconfig') };
    expect(runCheck(l, { work: dir, env, preCommit: 'p', postCommit: 'q', commands: [], scratch: join(dir, 'scratch') })).toBe('pass');
  });

  it('throws CheckerError on any other exit and on a timeout', () => {
    expect(() => check(['2'])).toThrow(CheckerError);
    expect(() => check(['2'])).toThrow(/exited 2/);
    const dir = checkDir();
    writeFileSync(join(dir, 'checks', 'slow.mjs'), 'setTimeout(() => {}, 20000);\n');
    const slow = { id: 's', check: { script: 'checks/slow.mjs' }, checkPath: join(dir, 'checks', 'slow.mjs') };
    expect(() => runCheck(slow, { work: dir, env: process.env, preCommit: 'p', postCommit: 'q', commands: [], scratch: join(dir, 'scratch'), timeoutMs: 300 })).toThrow(/timed out/);
  });
});
