// Z0 G5 (prereg 166, 179): the reader sample's seeded draw, blinding, labels and scoring, and the stored sample's statistics.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, readdirSync, renameSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { agentGit } from '../scripts/token-eval/checks.mjs';
import { readerDiff } from '../scripts/token-eval/grading.mjs';
import { runCli as analyze } from '../scripts/token-eval/z0-analyze.mjs';
import { checkerIdentity } from '../scripts/token-eval/lessons.mjs';
import { equalShares, fillStrata, kappa, parseLabels, seededOrder, wilson } from '../scripts/token-eval/g5-draw.mjs';
import { pairDiff } from '../scripts/token-eval/reader-sample.mjs';
import { listGrades } from '../scripts/token-eval/regrade.mjs';
import { g5 } from '../scripts/token-eval/z0-gates.mjs';
import { CHECKS, cleanup, tmp } from './fixtures/z0-harness.js';
import { GRADING, PRICES, generate, jsonl } from './fixtures/z0-gen.js';
import { PHRASE, SEQ, bundledOut, cli, gradeDir, readJson, rowOf, runRoot, sealedKey, storedRecord, synthOut, writeRows, type Cell, type Verdict } from './fixtures/z0-g5.js';

const win = process.platform === 'win32';
const ARM_WORD = /\b(A0|A1|A2|A4|A5|X1|X2|X3|X4)\b/;
interface KeyPair { file: string; pairId: string; key: string; lessonId: string; arm: string; verdict: string; stratum: string }
const cells = (arm: string, verdicts: Verdict[], from = 0): Cell[] => verdicts.map((first, i) => ({ arm, position: from + i, first }));
const many = (v: Verdict, k: number): Verdict[] => Array.from({ length: k }, () => v);
const draw = (out: string, tasks: string, extra: string[] = []) => cli(['reader', '--out', out, '--tasks', tasks, '--seed', '7', ...extra]);
const pairsOf = (out: string, round = 1): KeyPair[] => sealedKey(out, `reader-r${round}.key.json`).pairs;
const labelsFor = (pairs: KeyPair[], wrong: (p: KeyPair) => boolean = () => false) => pairs.map((p) => `${p.file}\t${wrong(p) ? (p.verdict === 'pass' ? 'fail' : 'pass') : p.verdict}\t\n`).join('');
const score = (out: string, text: string, extra: string[] = []) => {
  const file = join(tmp('z0-g5-labels-'), 'labels.tsv');
  writeFileSync(file, text);
  return cli(['reader', '--out', out, '--labels', file, ...extra]);
};
const gradingOf = (out: string) => {
  expect(cli(['grading', '--out', out])).toMatchObject({ code: 0 });
  return readJson(join(out, 'grading.json'));
};

describe('reader sample draw', () => {
  afterEach(cleanup);

  it('is a pure function of the seed and the eligible set, never of the listing order (21)', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
    expect(seededOrder(1, [...ids].reverse())).toEqual(seededOrder(1, ids));
    expect(seededOrder(2, ids)).not.toEqual(seededOrder(1, ids));
    const spec = [...cells('A0', [...many('pass', 8), ...many('fail', 8)]), ...cells('A1', [...many('pass', 8), ...many('fail', 8)])];
    const [a, b, c] = [synthOut(spec), synthOut(spec), synthOut(spec)];
    for (const x of [a, b]) expect(draw(x.out, x.tasks, ['--n', '10'])).toMatchObject({ code: 0 });
    expect(cli(['reader', '--out', c.out, '--tasks', c.tasks, '--seed', '8', '--n', '10'])).toMatchObject({ code: 0 });
    const ids0 = (out: string) => pairsOf(out).map((p) => p.pairId);
    expect(ids0(b.out)).toEqual(ids0(a.out));
    expect(ids0(c.out)).not.toEqual(ids0(a.out));
    // The same arguments again print the draw; other arguments for a drawn round are refused.
    expect(draw(a.out, a.tasks, ['--n', '10'])).toMatchObject({ code: 0, stdout: expect.stringContaining('already drawn') });
    expect(draw(a.out, a.tasks, ['--n', '12'])).toMatchObject({ code: 1, stderr: expect.stringContaining('was drawn with --seed 7 --n 10') });
    expect(cli(['reader', '--out', a.out, '--tasks', a.tasks])).toMatchObject({ code: 1, stderr: expect.stringContaining('needs --seed') });
  });

  it('gives each arm an equal share, splits it by verdict in proportion, and moves a short arm\'s share on (22, R18)', () => {
    expect([...equalShares(3, 10, ['A0', 'A1', 'A2']).values()].sort()).toEqual([3, 3, 4]);
    const s = synthOut([...cells('A0', [...many('pass', 10), ...many('fail', 10)]), ...cells('A1', [...many('pass', 15), ...many('fail', 5)]), ...cells('A2', ['pass', 'fail'])]);
    expect(draw(s.out, s.tasks, ['--n', '12'])).toMatchObject({ code: 0 });
    const pairs = pairsOf(s.out);
    const n = (arm: string, v?: string) => pairs.filter((p) => p.arm === arm && (v === undefined || p.verdict === v)).length;
    expect([n('A0'), n('A1'), n('A2')]).toEqual([5, 5, 2]);
    expect(n('A1', 'pass')).toBeGreaterThanOrEqual(3);
    expect(n('A0', 'pass')).toBeGreaterThanOrEqual(2);
    expect(n('A0', 'fail')).toBeGreaterThanOrEqual(2);
    // A stratum's shortfall goes to the same arm first.
    const groups = [{ share: 3, strata: [{ quota: 2, items: ['x1'] }, { quota: 1, items: ['y1', 'y2', 'y3'] }] }, { share: 3, strata: [{ quota: 3, items: ['z1', 'z2', 'z3', 'z4'] }] }];
    expect(fillStrata(groups, 6, () => true).taken).toEqual(['x1', 'y1', 'y2', 'z1', 'z2', 'z3']);
  });

  it('takes every pair when fewer than n are eligible, and the real G5 gate says the sample is short (23)', () => {
    const s = synthOut([...cells('A0', many('pass', 6)), ...cells('A1', many('fail', 6))]);
    expect(draw(s.out, s.tasks)).toMatchObject({ code: 0 });
    const pairs = pairsOf(s.out);
    expect(pairs).toHaveLength(12);
    expect(score(s.out, labelsFor(pairs))).toMatchObject({ code: 0 });
    const grading = gradingOf(s.out);
    expect(grading.readerSample).toEqual({ n: 12, disagreements: 0 });
    expect(g5(grading)).toMatchObject({ pass: false, status: 'reader sample short' });
  });

  it('pair files and labels.tsv hold no arm, seed, run name, verdict, checker path, memory command or run path in any spelling (24, R4, R9, R14)', () => {
    // The out dir carries a memory word in its name, so a path into the run must not read as a memory command.
    const s = synthOut([{ arm: 'A2', position: 0 }], 'z0-g5-hippo-out-');
    const root = realpathSync.native(runRoot(s.out, 'A2'));
    const fwd = root.replace(/\\/g, '/');
    const forms = [root, `${root}\\work`, fwd, root.replace(/\\/g, '\\\\'), root.replace(/[^a-zA-Z0-9]/g, '-')];
    if (win) {
      const tail = fwd.replace(/^([A-Za-z]):/, (_, d: string) => d.toLowerCase());
      forms.push(`/${tail}`, `/mnt/${tail}`, `/cygdrive/${tail}`, root.toUpperCase());
      const short = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${root}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim();
      if (short && short !== root) forms.push(short);
    }
    const diff = `diff --git a/lib.js b/lib.js\n${forms.map((f) => `+// ${f}/work/lib.js\n`).join('')}`;
    writeFileSync(join(gradeDir(s.out, 'A2'), 't0.first.diff'), diff);
    const grade = readJson(join(gradeDir(s.out, 'A2'), 't0.grade.json'));
    writeFileSync(join(gradeDir(s.out, 'A2'), 't0.grade.json'), JSON.stringify({ ...grade, commandsFirst: ['npm test', 'hippo recall x', `cat ${fwd}/work/lib.js`] }));
    expect(draw(s.out, s.tasks)).toMatchObject({ code: 0 });
    const dir = join(s.out, 'g5', 'reader-r1');
    const text = ['p01.md', 'labels.tsv'].map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    expect(text).toContain('<run>/work/lib.js');
    expect(text).toContain('npm test');
    for (const bad of [SEQ, 'seed1', 'hippo', 'recall', '[command hidden]', 'verdict', 'lesson.mjs', 'f1-l1', root, fwd, root.toLowerCase()]) expect(text.toLowerCase()).not.toContain(bad.toLowerCase());
    expect(text).not.toMatch(ARM_WORD);
    expect(readdirSync(dir).sort()).toEqual(['labels.tsv', 'p01.md']);
    expect(pairsOf(s.out)[0]).toMatchObject({ file: 'p01', droppedCommands: 1 });
  });

  it('drops every command that names an instruction or memory file, and the reader diff leaves those files out (24b)', () => {
    const commands = ['npm test', 'cat AGENTS.md', 'ls .claude\\rules', 'cat sub/CLAUDE.local.md', 'cat AGENTS.override.md', 'head MEMORY.md'];
    const s = synthOut([{ arm: 'A0', position: 0, commands }]);
    expect(draw(s.out, s.tasks)).toMatchObject({ code: 0 });
    const text = readFileSync(join(s.out, 'g5', 'reader-r1', 'p01.md'), 'utf8');
    expect(text).toContain('npm test');
    for (const bad of ['AGENTS', 'CLAUDE', 'rules', 'MEMORY']) expect(text).not.toContain(bad);
    expect(pairsOf(s.out)[0]).toMatchObject({ droppedCommands: 5 });

    const repo = tmp('z0-g5-hide-');
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q');
    writeFileSync(join(repo, 'lib.js'), '1\n');
    git('add', '-A');
    git('commit', '-qm', 'a');
    const from = git('rev-parse', 'HEAD');
    const files = ['lib.js', 'AGENTS.md', 'AGENTS.override.md', 'MEMORY.md', 'docs/MEMORY.md', 'sub/CLAUDE.local.md', '.claude/rules/r.md'];
    for (const f of files) {
      mkdirSync(dirname(join(repo, f)), { recursive: true });
      writeFileSync(join(repo, f), '2\n');
    }
    git('add', '-A');
    git('commit', '-qm', 'b');
    const to = git('rev-parse', 'HEAD');
    const diff: string = agentGit(repo, (rgit: (a: string[], cwd: string) => string) => readerDiff(rgit, repo, from, to));
    expect(diff).toContain('lib.js');
    for (const f of files.slice(1)) expect(diff).not.toContain(f);
  });

  it('keeps a pair that names the run name as a plain word, since every arm shares it; only its path forms are forbidden (25b)', () => {
    const s = synthOut([{ arm: 'A0', position: 0, diff: `diff --git a/lib.js b/lib.js\n+// the ${SEQ} parser\n` }, { arm: 'A0', position: 1, diff: `diff --git a/lib.js b/lib.js\n+// x/${SEQ}/y\n` }]);
    expect(draw(s.out, s.tasks)).toMatchObject({ code: 0 });
    expect(sealedKey(s.out, 'reader-r1.key.json')).toMatchObject({ unblindable: 1, pairs: [{ pairId: `${listGrades(s.out)[0].key}:first` }] });
  });

  it('refuses a pair that names an arm or a seed as a standalone word, and keeps code words that only contain one (25c)', () => {
    const plain = (line: string) => `diff --git a/lib.js b/lib.js\n+${line}\n`;
    const s = synthOut([
      { arm: 'A0', position: 0, commands: ['npm test', 'echo A2 seed1'] },
      { arm: 'A0', position: 1, diff: plain('// tuned for X4') },
      { arm: 'A0', position: 2, diff: plain('// Seed12 case') },
      { arm: 'A0', position: 3, diff: plain('const x1 = seeds.A0x; // a1b2 seedling') },
    ]);
    expect(draw(s.out, s.tasks)).toMatchObject({ code: 0 });
    expect(sealedKey(s.out, 'reader-r1.key.json')).toMatchObject({ unblindable: 3, pairs: [{ pairId: `${listGrades(s.out)[3].key}:first` }] });
  });

  it('replaces a pair whose blinded text still names the memory tool from its own stratum (25)', () => {
    const s = synthOut(cells('A0', many('pass', 4)));
    const first = seededOrder(7, listGrades(s.out).map((e) => `${e.key}:first`))[0];
    const taskId = `t${first.split('@')[1].split('/')[0]}`;
    writeFileSync(join(gradeDir(s.out, 'A0'), `${taskId}.first.diff`), '+// ask hippo first\n');
    expect(draw(s.out, s.tasks, ['--n', '3'])).toMatchObject({ code: 0 });
    const key = sealedKey(s.out, 'reader-r1.key.json');
    expect(key.unblindable).toBe(1);
    expect(key.unblindableByStratum).toEqual({ 'A0/pass': 1 });
    expect(key.pairs.map((p: KeyPair) => p.pairId)).not.toContain(first);
    expect(key.pairs).toHaveLength(3);
  });

  it('rebuilds a deleted reader diff byte for byte from the stub and the bundle (7)', () => {
    const b = bundledOut();
    expect(b.diff).toContain('lib.js');
    expect(b.diff).not.toContain('CLAUDE.md');
    const entry = listGrades(b.out)[0];
    rmSync(join(b.dir, 't0.first.diff'));
    expect(pairDiff(b.out, entry, 'first')).toBe(b.diff);
    expect(draw(b.out, b.tasks)).toMatchObject({ code: 0 });
    expect(readFileSync(join(b.out, 'g5', 'reader-r1', 'p01.md'), 'utf8')).toContain('+module.exports = 2;');
  });

  it('counts a pair with neither its diff nor its bundle as ineligible, never drawing it (8)', () => {
    const b = bundledOut();
    rmSync(join(b.dir, 't0.first.diff'));
    rmSync(join(b.dir, 't0.bundle'));
    expect(draw(b.out, b.tasks)).toMatchObject({ code: 0, stdout: expect.stringContaining('1 ineligible') });
    expect(sealedKey(b.out, 'reader-r1.key.json')).toMatchObject({ eligible: 0, ineligible: 1, pairs: [] });
  });
});

/** A link to `target`: a junction on Windows, a symlink elsewhere, like macOS /var to /private/var. */
function linkTo(target: string) {
  const link = join(tmp('z0-g5-link-'), 'out');
  symlinkSync(target, link, win ? 'junction' : 'dir');
  return link;
}

describe('reader sample exclusions and path aliases', () => {
  afterEach(cleanup);

  it('leaves out the lessons an error row drops: refused by default, excluded under --flip-errors as grading does (27c)', () => {
    const s = synthOut(cells('A0', many('pass', 4)));
    const entries = listGrades(s.out);
    for (const e of entries.slice(2)) writeFileSync(e.file, JSON.stringify({ ...e.grade, lessonId: 'f1-l2', checkers: { 'f1-l2': 'x' } }));
    const l2 = listGrades(s.out).slice(2).map((e) => e.grade);
    const done = (g: typeof l2[number]) => ({ ...rowOf(g), lessonId: 'f1-l2', checks: rowOf(g).checks.map((c) => ({ ...c, lessonId: 'f1-l2' })) });
    const error = { ...done(l2[0]), status: 'error', error: { stage: 'git', message: 'broken' }, checks: [], acceptance: null };
    writeRows(s.out, [...entries.slice(0, 2).map((e) => rowOf(e.grade)), error, done(l2[1])]);
    const spec = readJson(s.tasks);
    spec.families[0].lessons.push({ id: 'f1-l2', rule: 'Write the second file', keyPhrase: 'zq-f1-l2' });
    writeFileSync(s.tasks, JSON.stringify(spec));
    expect(draw(s.out, s.tasks)).toMatchObject({ code: 1, stderr: expect.stringContaining('1 cells have error rows') });
    expect(draw(s.out, s.tasks, ['--flip-errors'])).toMatchObject({ code: 0 });
    expect(sealedKey(s.out, 'reader-r1.key.json')).toMatchObject({ eligible: 2 });
    expect(pairsOf(s.out).map((p) => p.lessonId)).toEqual(['f1-l1', 'f1-l1']);
  });

  it('blinds run paths spelled through a link to --out the same as their real spelling (28b, macOS /var)', () => {
    const s = synthOut([{ arm: 'A0', position: 0 }]);
    const link = linkTo(s.out);
    writeFileSync(join(gradeDir(s.out, 'A0'), 't0.first.diff'), `diff --git a/lib.js b/lib.js\n+// ${runRoot(link, 'A0')}/work/lib.js\n`);
    expect(draw(link, s.tasks)).toMatchObject({ code: 0 });
    expect(sealedKey(s.out, 'reader-r1.key.json')).toMatchObject({ unblindable: 0 });
    expect(readFileSync(join(s.out, 'g5', 'reader-r1', 'p01.md'), 'utf8')).toContain('<run>/work/lib.js');
  });
});

describe('reader sample labels and scoring', () => {
  afterEach(cleanup);

  it('parses BOM, CRLF and blank lines, and names the line of every fault (26)', () => {
    const ids = ['p01', 'p02'];
    expect([...parseLabels('﻿# id\tlabel\r\np01\tpass\tok\r\np02\tna\r\n\r\n\r\n', ids, ['pass', 'fail', 'na'])]).toEqual([['p01', 'pass'], ['p02', 'na']]);
    expect(() => parseLabels('p01\tpass\np03\tfail\n', ids, ['pass'])).toThrow('labels line 2: unknown id p03');
    expect(() => parseLabels('p01\tpass\np01\tpass\n', ids, ['pass'])).toThrow('labels line 2: p01 is labelled twice');
    expect(() => parseLabels('p01\tmaybe\n', ids, ['pass'])).toThrow('labels line 1: label "maybe"');
    expect(() => parseLabels('p01\tpass\n', ids, ['pass'])).toThrow('no label for p02');
  });

  it('counts disagreements, leaves round 1 out of round 2, and re-scores round 1 against post-fix verdicts (27)', () => {
    const s = synthOut([...cells('A0', many('pass', 10)), ...cells('A1', many('fail', 10))]);
    expect(draw(s.out, s.tasks, ['--n', '6'])).toMatchObject({ code: 0 });
    const r1 = pairsOf(s.out);
    expect(cli(['grading', '--out', s.out])).toMatchObject({ code: 1, stderr: expect.stringContaining('round 1 is drawn but not scored') });
    const wrong = new Set(r1.slice(0, 2).map((p) => p.file));
    expect(score(s.out, labelsFor(r1, (p) => wrong.has(p.file)))).toMatchObject({ code: 0, stdout: expect.stringContaining('2 of 6') });
    expect(gradingOf(s.out)).toMatchObject({ readerSample: { n: 6, disagreements: 2 }, g5: { readerRound: 1, readerEligible: 20, readerRound1Rescored: null } });

    // The fixed checker turns every A1 verdict to pass, so round 1's labels of A1 pairs now disagree.
    writeRows(s.out, listGrades(s.out).map((e) => rowOf(e.grade, 'postfix', e.grade.arm === 'A1' ? { first: 'pass' } : {}, 'y')), 'postfix');
    expect(draw(s.out, s.tasks, ['--round', '2', '--n', '6'])).toMatchObject({ code: 0 });
    const r2 = pairsOf(s.out, 2);
    expect(r2.filter((p) => r1.some((q) => q.pairId === p.pairId))).toEqual([]);
    expect(r2.every((p) => p.verdict === 'pass')).toBe(true);
    expect(score(s.out, labelsFor(r2), ['--round', '2'])).toMatchObject({ code: 0 });
    const a1Right = r1.filter((p) => p.arm === 'A1' && !wrong.has(p.file)).length;
    const a0Wrong = r1.filter((p) => p.arm === 'A0' && wrong.has(p.file)).length;
    expect(gradingOf(s.out)).toMatchObject({ readerSample: { n: 6, disagreements: 0 }, g5: { readerRound: 2, readerEligible: 14, readerRound1Rescored: { n: 6, disagreements: a1Right + a0Wrong } } });
    expect(existsSync(join(s.out, 'g5', 'sealed', 'reader-r2.score.json'))).toBe(true);
  });

  it('an args-only checker fix lets round 2 draw; the unchanged invocation does not (27c, 166)', () => {
    const lesson = (args: string[]) => ({ checkPath: join(CHECKS, 'toggle.mjs'), check: { script: 'toggle.mjs', args } });
    const [before, after] = [checkerIdentity(lesson([])), checkerIdentity(lesson(['--strict']))];
    expect(after).not.toBe(before);
    const s = synthOut([...cells('A0', many('pass', 10)), ...cells('A1', many('fail', 10))]);
    for (const e of listGrades(s.out)) writeFileSync(e.file, JSON.stringify({ ...e.grade, checkers: { 'f1-l1': before } }));
    expect(draw(s.out, s.tasks, ['--n', '6'])).toMatchObject({ code: 0 });
    expect(score(s.out, labelsFor(pairsOf(s.out), () => true))).toMatchObject({ code: 0 });
    const postfix = (id: string) => writeRows(s.out, listGrades(s.out).map((e) => rowOf(e.grade, 'postfix', {}, id)), 'postfix');
    postfix(before);
    expect(draw(s.out, s.tasks, ['--round', '2', '--n', '6'])).toMatchObject({ code: 1, stderr: expect.stringContaining('no checker changed since reader round 1') });
    postfix(after);
    expect(draw(s.out, s.tasks, ['--round', '2', '--n', '6'])).toMatchObject({ code: 0 });
  });

  it('draws round K only after round K-1 failed and a checker changed since its draw; a scored round is final (27b, 166)', () => {
    const fresh = () => synthOut([...cells('A0', many('pass', 10)), ...cells('A1', many('fail', 10))]);
    const postfix = (out: string, sha: string) => writeRows(out, listGrades(out).map((e) => rowOf(e.grade, 'postfix', {}, sha)), 'postfix');
    const next = (s: { out: string; tasks: string }, k: number) => draw(s.out, s.tasks, ['--round', String(k), '--n', '6']);
    const allWrong = () => true;

    const passed = fresh();
    expect(draw(passed.out, passed.tasks, ['--n', '6'])).toMatchObject({ code: 0 });
    postfix(passed.out, 'y');
    expect(next(passed, 2)).toMatchObject({ code: 1, stderr: expect.stringContaining('reader round 1 is not scored') });
    expect(score(passed.out, labelsFor(pairsOf(passed.out)))).toMatchObject({ code: 0 });
    expect(next(passed, 2)).toMatchObject({ code: 1, stderr: expect.stringContaining('reader round 1 passed') });
    // The same labels again print the score; other labels for a scored round are refused, so a failed round is never re-labelled.
    expect(score(passed.out, labelsFor(pairsOf(passed.out)))).toMatchObject({ code: 0, stdout: expect.stringContaining('0 of 6') });
    expect(score(passed.out, labelsFor(pairsOf(passed.out), allWrong))).toMatchObject({ code: 1, stderr: expect.stringContaining('already scored') });

    const failed = fresh();
    expect(draw(failed.out, failed.tasks, ['--n', '6'])).toMatchObject({ code: 0 });
    expect(score(failed.out, labelsFor(pairsOf(failed.out), allWrong))).toMatchObject({ code: 0 });
    postfix(failed.out, 'x');
    expect(next(failed, 2)).toMatchObject({ code: 1, stderr: expect.stringContaining('no checker changed since reader round 1') });
    postfix(failed.out, 'y');
    expect(next(failed, 2)).toMatchObject({ code: 0 });
    expect(score(failed.out, labelsFor(pairsOf(failed.out, 2), allWrong), ['--round', '2'])).toMatchObject({ code: 0 });
    expect(next(failed, 3)).toMatchObject({ code: 1, stderr: expect.stringContaining('no checker changed since reader round 2') });
    postfix(failed.out, 'z');
    expect(next(failed, 3)).toMatchObject({ code: 0 });
  });

  it('refuses a grade.json in the wrong folder, and every alias of --out shares one lock (31)', () => {
    const s = synthOut(cells('A0', many('pass', 3)));
    mkdirSync(gradeDir(s.out, 'A1'), { recursive: true });
    renameSync(join(gradeDir(s.out, 'A0'), 't0.grade.json'), join(gradeDir(s.out, 'A1'), 't0.grade.json'));
    expect(draw(s.out, s.tasks)).toMatchObject({ code: 1, stderr: expect.stringContaining('which is not the folder it sits in') });
    if (!win) return;
    const t = synthOut(cells('A0', many('pass', 3)));
    const link = join(tmp('z0-g5-link-'), 'out');
    symlinkSync(t.out, link, 'junction');
    mkdirSync(join(t.out, 'g5'), { recursive: true });
    writeFileSync(join(t.out, 'g5', 'regrade.lock'), '1\n');
    for (const alias of [link, t.out.toUpperCase()]) expect(draw(alias, t.tasks)).toMatchObject({ code: 1, stderr: expect.stringContaining('regrade.lock exists') });
    rmSync(join(t.out, 'g5', 'regrade.lock'));
    expect(draw(link, t.tasks)).toMatchObject({ code: 0 });
    expect(existsSync(join(t.out, 'g5', 'sealed', 'reader-r1.key.json'))).toBe(true);
  });
});

describe('stored sample (179)', () => {
  afterEach(cleanup);

  /** 15 judged yes and 15 judged no, plus one cut, one empty and one hidden-hit unit; `viaLink` spells every path through a link. */
  function storedOut(viaLink = false) {
    const s = synthOut([{ arm: 'A0', position: 100 }]);
    const out = viaLink ? linkTo(s.out) : s.out;
    const records = [];
    const surfaces = (arm: string, seed: number, position: number, text: string) => {
      mkdirSync(gradeDir(s.out, arm, seed), { recursive: true });
      mkdirSync(runRoot(s.out, arm, seed), { recursive: true });
      writeFileSync(join(gradeDir(s.out, arm, seed), `t${position}.surfaces.txt`), text);
    };
    for (let i = 0; i < 33; i++) {
      const [arm, seed, position] = [i % 2 ? 'A1' : 'A0', 1 + (i % 2), i];
      const yes = i < 15 || i === 32;
      const root = runRoot(out, arm, seed);
      records.push(storedRecord(arm, seed, position, yes));
      let text = `=== ${root}\\work\\CLAUDE.md\nSee ${root}\\work\\lib.js. hippo keeps ${yes ? PHRASE : 'nothing'}.\n=== ${root}\\.hippo\\hippo.db#12\nan entry\n`;
      if (i === 30) text = `=== CLAUDE.md\n${'x'.repeat(10)}\n[cut at 65536 chars]\n`;
      if (i === 31) text = '\n';
      if (i === 32) text = `=== CLAUDE.md\nnothing here\n=== .claude/settings.json\n${PHRASE}\n`;
      surfaces(arm, seed, position, text);
    }
    writeFileSync(join(s.out, 'runs.jsonl'), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
    writeFileSync(s.tasks, JSON.stringify({ families: [{ id: 'f1', lessons: [{ id: 'f1-l1', rule: 'Write the lesson file', keyPhrase: PHRASE }] }], sequences: [{ id: SEQ, tasks: [] }] }));
    return { ...s, out };
  }

  it('blinds surface texts spelled through a link to --out, as the run spells them on macOS (28c)', () => {
    const s = storedOut(true);
    expect(cli(['stored', '--out', s.out, '--tasks', s.tasks, '--seed', '3'])).toMatchObject({ code: 0 });
    expect(sealedKey(s.out, 'stored.key.json')).toMatchObject({ eligible: 30, unblindable: 0 });
  });

  it('excludes cut, empty and hidden-hit texts, blinds the rest, and scores agreement, Wilson and kappa (28, R15, R16)', () => {
    const s = storedOut();
    expect(cli(['stored', '--out', s.out, '--tasks', s.tasks, '--seed', '3'])).toMatchObject({ code: 0 });
    const key = sealedKey(s.out, 'stored.key.json');
    expect(key).toMatchObject({ eligible: 30, excluded: { cut: 1, empty: 1, hiddenHit: 1 }, unblindable: 0 });
    expect(key.units).toHaveLength(30);
    const dir = join(s.out, 'g5', 'stored');
    const blind = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    for (const bad of ['hippo', 'CLAUDE.md', '.db#', 'seed1', 'seed2', SEQ, s.out]) expect(blind.toLowerCase()).not.toContain(bad.toLowerCase());
    expect(blind).not.toMatch(ARM_WORD);
    expect(blind).toContain('=== part 1\nSee <run>\\work\\lib.js. [tool] keeps');
    expect(blind).toContain('Write the lesson file');

    // Table (12, 3, 2, 13): 12 yes-yes, 3 yes-no, 2 no-yes, 13 no-no.
    const units: { file: string; judged: string }[] = key.units;
    const yes = units.filter((u) => u.judged === 'yes');
    const no = units.filter((u) => u.judged === 'no');
    const label = (u: { file: string; judged: string }) => (u.judged === 'yes' ? (yes.indexOf(u) < 12 ? 'yes' : 'no') : no.indexOf(u) < 2 ? 'yes' : 'no');
    const file = join(tmp('z0-g5-st-'), 'labels.tsv');
    writeFileSync(file, units.map((u) => `${u.file}\t${label(u)}\n`).join(''));
    expect(cli(['stored', '--out', s.out, '--labels', file])).toMatchObject({ code: 0, stdout: expect.stringContaining('25 of 30') });
    const st = gradingOf(s.out).storedSample;
    expect(st).toMatchObject({ n: 30, agree: 25, table: { yesYes: 12, yesNo: 3, noYes: 2, noNo: 13 }, excluded: { cut: 1, empty: 1, hiddenHit: 1 } });
    expect(st.agreement).toBeCloseTo(0.8333, 4);
    expect(st.kappa).toBeCloseTo(0.6667, 4);
    expect(st.ci95[0]).toBeCloseTo(0.6644, 4);
    expect(st.ci95[1]).toBeCloseTo(0.9266, 4);
    expect(wilson(25, 30)?.map((x) => Number(x.toFixed(4)))).toEqual([0.6644, 0.9266]);
    expect(kappa({ yesYes: 4, yesNo: 0, noYes: 0, noNo: 0 })).toBeNull();
  });

  it('wilson stays inside [0, 1] at full and zero agreement, and the analyzer takes the scorer\'s own full-agreement output (28d)', () => {
    for (const n of [1, 16, 30, 50]) {
      expect(wilson(n, n)![1]).toBeLessThanOrEqual(1);
      expect(wilson(n, n)![1]).toBeCloseTo(1, 12);
      expect(wilson(0, n)![0]).toBeGreaterThanOrEqual(0);
      expect(wilson(0, n)![0]).toBeCloseTo(0, 12);
      expect(wilson(n, n)![0]).toBeGreaterThanOrEqual(0);
    }
    expect(wilson(16, 16)![1]).toBe(1);
    const s = storedOut();
    expect(cli(['stored', '--out', s.out, '--tasks', s.tasks, '--seed', '3', '--n', '16'])).toMatchObject({ code: 0 });
    const units: { file: string; judged: string }[] = sealedKey(s.out, 'stored.key.json').units;
    const file = join(tmp('z0-g5-st-'), 'labels.tsv');
    writeFileSync(file, units.map((u) => `${u.file}\t${u.judged}\n`).join(''));
    expect(cli(['stored', '--out', s.out, '--labels', file])).toMatchObject({ code: 0, stdout: expect.stringContaining('16 of 16') });
    const stored = gradingOf(s.out).storedSample;
    expect(stored.ci95[1]).toBe(1);
    const g = generate();
    const dir = tmp('z0-g5-an-');
    const files = { 'runs.jsonl': jsonl(g.records), 'plan.json': JSON.stringify(g.plan), 'prices.json': JSON.stringify(PRICES), 'grading.json': JSON.stringify({ ...GRADING, storedSample: stored }) };
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    const r = analyze(['--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--grading', 'grading.json', '--iterations', '300'], dir);
    expect(r).toMatchObject({ code: 0, stderr: '' });
  });

  it('puts no arm name in any key or string of grading.json (29, R11)', () => {
    const s = synthOut([...cells('A0', many('pass', 4)), ...cells('A2', many('fail', 4))]);
    expect(draw(s.out, s.tasks)).toMatchObject({ code: 0 });
    expect(score(s.out, labelsFor(pairsOf(s.out)))).toMatchObject({ code: 0 });
    gradingOf(s.out);
    // Every key and string value sits in the JSON text, so one scan of the file covers both.
    const text = readFileSync(join(s.out, 'grading.json'), 'utf8');
    expect(text).toContain('readerSample');
    expect(text).not.toMatch(ARM_WORD);
  });
});
