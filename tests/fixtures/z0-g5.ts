// Synthetic G5 out dirs for the reader and stored sample tests: grade.json, diffs and done rows written directly, no fake run.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { agentGit } from '../../scripts/token-eval/checks.mjs';
import { readerDiff } from '../../scripts/token-eval/grading.mjs';
import { cellKey } from '../../scripts/token-eval/z0-records.mjs';
import { runCli } from '../../scripts/token-eval/z0-regrade.mjs';
import { generate, type Z0Record } from './z0-gen.js';
import { tmp } from './z0-harness.js';

export type Verdict = 'pass' | 'fail' | 'na';
export interface Cell { arm: string; position: number; seed?: number; kind?: 'teach' | 'apply'; first?: Verdict; final?: Verdict; finalChecked?: boolean; diff?: string; commands?: string[] }
export const SEQ = 'seqF';
export const RULE = 'Write the lesson file';
export const PHRASE = 'zq-f1-l1';

export const runRoot = (out: string, arm: string, seed = 1) => join(out, 'runs', SEQ, arm, `seed${seed}`);
export const gradeDir = (out: string, arm: string, seed = 1) => join(out, 'grading', SEQ, arm, `seed${seed}`);

function gradeOf(c: Cell) {
  const first: Verdict = c.first ?? 'pass';
  const commands = c.commands ?? ['npm test'];
  return {
    sequence: SEQ, runName: SEQ, arm: c.arm, seed: c.seed ?? 1, position: c.position, order: c.position, taskId: `t${c.position}`, kind: c.kind ?? 'apply',
    lessonId: 'f1-l1', staleLessonId: null, stubRef: `refs/eval/${SEQ}/t${c.position}`, stub: 's', pre: 'p', first: 'f', final: 'f',
    finalChecked: c.finalChecked ?? false, finalCheck: c.finalChecked ? 'f' : null, stale: null,
    verdicts: { first, final: c.final ?? first, staleFollow: null }, acceptancePassed: true,
    commandsFirst: commands, commandsFinal: commands, commandsStale: null, checkers: { 'f1-l1': 'x' },
  };
}
export type Grade = ReturnType<typeof gradeOf>;

/** A done repro row whose verdicts equal the saved ones; `regraded` and `checkerSha` override them for a post-fix row. */
export function rowOf(g: Grade, pass: 'repro' | 'postfix' = 'repro', regraded: Partial<Record<'first' | 'final', Verdict>> = {}, checkerSha = g.checkers['f1-l1']) {
  const v = g.verdicts;
  const which = g.finalChecked ? (['first', 'final'] as const) : (['first'] as const);
  const checks = which.map((w) => ({ lessonId: 'f1-l1', which: w, saved: v[w], regraded: regraded[w] ?? v[w], flip: false, reason: null, checkerSha }));
  return { schema: 'z0-regrade/1', pass, key: cellKey(g), status: 'done', error: null, lessonId: 'f1-l1', staleLessonId: null, checks, acceptance: { saved: true, regraded: true, flip: false, reason: null }, extraEnvKeys: [] };
}

export const writeRows = (out: string, rows: object[], pass: 'repro' | 'postfix' = 'repro') => {
  mkdirSync(join(out, 'g5'), { recursive: true });
  writeFileSync(join(out, 'g5', pass === 'postfix' ? 'regrade.postfix.jsonl' : 'regrade.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
};

/** The tasks file a reader needs: one lesson and one prompt per position. */
export function writeTasks(out: string, positions: number[]) {
  const tasks = [...new Set(positions)].map((p) => ({ id: `t${p}`, prompt: `Fix bug ${p} in lib.js` }));
  const file = join(out, 'tasks.json');
  writeFileSync(file, JSON.stringify({ families: [{ id: 'f1', lessons: [{ id: 'f1-l1', rule: RULE, keyPhrase: PHRASE }] }], sequences: [{ id: SEQ, tasks }] }));
  return file;
}

/** An out dir holding these cells, each with its reader diffs and a done repro row; run roots exist so realpath forms resolve. */
export function synthOut(cells: Cell[], prefix = 'z0-g5-out-') {
  const out = tmp(prefix);
  const grades = cells.map((c) => {
    const g = gradeOf(c);
    const dir = gradeDir(out, c.arm, g.seed);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(runRoot(out, c.arm, g.seed), 'work'), { recursive: true });
    writeFileSync(join(dir, `${g.taskId}.grade.json`), JSON.stringify(g));
    const diff = c.diff ?? `diff --git a/lib.js b/lib.js\n+fix ${c.position}\n`;
    writeFileSync(join(dir, `${g.taskId}.first.diff`), diff);
    if (c.finalChecked) writeFileSync(join(dir, `${g.taskId}.final.diff`), diff);
    return g;
  });
  writeRows(out, grades.map((g) => rowOf(g)));
  return { out, grades, tasks: writeTasks(out, cells.map((c) => c.position)) };
}

const gitIn = (cwd: string) => (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

/** One apply cell with a real stub, bundle and first.diff, laid out as saveGrading writes them. */
export function bundledOut() {
  const out = tmp('z0-g5-bundle-');
  const cache = join(out, 'repo-cache', SEQ);
  mkdirSync(cache, { recursive: true });
  const c = gitIn(cache);
  c('init', '-q');
  writeFileSync(join(cache, 'lib.js'), 'module.exports = 1;\n');
  c('add', '-A');
  c('commit', '-qm', 'stub');
  const stub = c('rev-parse', 'HEAD');
  c('update-ref', `refs/eval/${SEQ}/t0`, stub);
  const work = join(out, 'runs', SEQ, 'A0', 'seed1', 'work');
  execFileSync('git', ['clone', '-q', cache, work]);
  const w = gitIn(work);
  w('commit', '-q', '--allow-empty', '-m', 'pre');
  const pre = w('rev-parse', 'HEAD');
  writeFileSync(join(work, 'lib.js'), 'module.exports = 2;\n');
  writeFileSync(join(work, 'CLAUDE.md'), 'an instruction file the reader never sees\n');
  w('add', '-A');
  w('commit', '-qm', 'first');
  const first = w('rev-parse', 'HEAD');
  for (const [k, sha] of [['pre', pre], ['first', first], ['final', first]]) w('update-ref', `refs/z0/grade/${k}`, sha);
  const dir = gradeDir(out, 'A0');
  mkdirSync(dir, { recursive: true });
  w('bundle', 'create', '-q', join(dir, 't0.bundle'), 'refs/z0/grade/pre', 'refs/z0/grade/first', 'refs/z0/grade/final', `^${stub}`);
  const diff: string = agentGit(work, (rgit: (a: string[], cwd: string) => string) => readerDiff(rgit, work, pre, first));
  writeFileSync(join(dir, 't0.first.diff'), diff);
  const g = { ...gradeOf({ arm: 'A0', position: 0 }), stub, pre, first, final: first };
  writeFileSync(join(dir, 't0.grade.json'), JSON.stringify(g));
  writeRows(out, [rowOf(g)]);
  return { out, grade: g, diff, dir, tasks: writeTasks(out, [0]) };
}

/** A valid apply record for (arm, seed, position) with the given stored judgement, cloned from the generator's shape. */
export function storedRecord(arm: string, seed: number, position: number, stored: boolean): Z0Record {
  const base = generate({ arms: ['A0'], repos: 1 }).records.find((r) => r.kind === 'apply' && r.afterReversal === false)!;
  const lessons = base.lessons.map((l) => ({ ...l, lessonId: 'f1-l1' }));
  return { ...base, sequence: SEQ, arm, seed, position, taskId: `t${position}`, lessons, chain: { stored, shown: true, followed: true, captured: null } };
}

export const cli = (argv: string[]) => runCli(argv);
export const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
export const sealedKey = (out: string, name: string) => readJson(join(out, 'g5', 'sealed', name));
