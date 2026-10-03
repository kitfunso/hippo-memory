// Z0 lesson tasks end to end with the fake Claude Code: checks, teach and correction resumes, A4, the resume-limit
// restore and every record shape against the z0-record/1 contract. Costs nothing; the fake's token numbers are made up.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { runAll, planRuns, validateTasks } from '../scripts/token-eval/ab-run.mjs';
import * as records from '../scripts/token-eval/records.mjs';
import { teachMessage, drawOrder } from '../scripts/token-eval/lessons.mjs';
import { stateCommit, holdPre, dropPre, runCheck } from '../scripts/token-eval/checks.mjs';
import { stubBaseCommit, STUB_CLAUDE_MD } from '../scripts/token-eval/workspace.mjs';
import { runScreen } from '../scripts/token-eval/screen.mjs';
import { loadHippo } from '../scripts/token-eval/runs.mjs';
import { validateCorpus, type Z0Record, type Z0PlanCell } from './fixtures/z0-contract';

const FAKE = resolve(__dirname, 'fixtures', 'fake-claude.mjs');
const CLAUDE = `"${process.execPath}" "${FAKE}"`;
const CHECKS = resolve(__dirname, 'fixtures', 'z0-checks');
const dirs: string[] = [];
const envKeys = ['HOME', 'USERPROFILE', 'APPDATA', 'FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_LIMIT_ONCE', 'FAKE_CLAUDE_LIMIT_ALWAYS', 'GIT_CONFIG_GLOBAL'];
const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
const savedCwd = process.cwd();
afterEach(() => {
  process.chdir(savedCwd);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
// Long sync tests starve the worker's RPC; a macrotask turn between tests lets its replies through.
afterEach(() => new Promise((r) => setTimeout(r, 0)));

const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

/** Temp HOME, USERPROFILE, APPDATA and cwd, and a fresh fake-Claude log; returns the out dir and the log path. */
function isolate(name: string) {
  const home = tmp(`z0-turns-home-${name}-`);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
  process.chdir(tmp('z0-turns-cwd-'));
  const out = tmp(`z0-turns-out-${name}-`);
  const log = join(tmp('z0-turns-log-'), 'fake.log');
  process.env.FAKE_CLAUDE_LOG = log;
  return { out, log };
}

interface FixtureRepo { repo: string; base: string; fix: string }

function makeRepo(): FixtureRepo {
  const repo = tmp('z0-turns-repo-');
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'lib.js'), 'module.exports.add = (a, b) => a - b;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'lib.js'), 'module.exports.add = (a, b) => a + b;\n');
  writeFileSync(join(repo, 'test.js'), "const { add } = require('./lib.js');\nif (add(2, 3) !== 5) process.exit(1);\n");
  git('add', '.');
  git('commit', '-qm', 'fix');
  return { repo, base, fix: git('rev-parse', 'HEAD') };
}

interface LessonDef { id: string; rule: string; reason: string; keyPhrase: string; check: { script: string; args: string[] }; supersedes?: string }
interface FamilyDef { id: string; sequence: string; lessonSource: string; lessons: LessonDef[]; screen: object }
interface TaskDef {
  id: string; kind: string; baseRef: string; fixRef: string; prompt: string; testFiles: string[]; test: string;
  familyId?: string; lessonId?: string; setup?: string;
}
interface RunExtra { limitWaitMs?: number; limitMaxWaits?: number; sessionTimeoutMs?: number; log?: (m: string) => void }
/** What the toy lesson checker logs per call; the probe fields appear only with its `probe` arg. */
interface CheckLine {
  lesson: string; pre: string; post: string; preRef: string | null; commands: string[]; has?: boolean;
  head?: string; symbolic?: string | null; logAll?: string; reflog?: string | null; refs?: string;
}
const lesson = (id: string, rule: string, extra: Partial<LessonDef> = {}): LessonDef => ({ id, rule, reason: `the ${id} checker reads it`, keyPhrase: `zq-${id}`, check: { script: 'lesson.mjs', args: [] }, ...extra });
const family = (id: string, lessons: LessonDef[]): FamilyDef => ({ id, sequence: 'seqF', lessonSource: 'maintainer', lessons, screen: { id: `${id}-screen`, baseRef: 'x', fixRef: 'x', prompt: 'screen', test: 'node test.js', testFiles: [] } });
const task = (r: FixtureRepo, id: string, prompt: string, extra: Partial<TaskDef> = {}): TaskDef => ({ id, kind: 'no-lesson', baseRef: r.base, fixRef: r.fix, prompt, testFiles: ['test.js'], test: 'node test.js', ...extra });
const teach = (r: FixtureRepo, id: string, lessonId: string, prompt: string, extra: Partial<TaskDef> = {}) => task(r, id, prompt, { kind: 'teach', familyId: lessonId.split('-')[0], lessonId, ...extra });
const apply = (r: FixtureRepo, id: string, lessonId: string, prompt: string, extra: Partial<TaskDef> = {}) => task(r, id, prompt, { kind: 'apply', familyId: lessonId.split('-')[0], lessonId, ...extra });
const plain = (r: FixtureRepo, id: string) => task(r, id, 'look around only');
const spec = (r: FixtureRepo, families: FamilyDef[], tasks: TaskDef[]) => validateTasks({ families, sequences: [{ id: 'seqF', cluster: 'c', repo: r.repo, fixedOrder: true, tasks }] }, CHECKS);
/** The usual reversal family: f1-l1 then f1-l2 superseding it. */
const reversal = (l1: Partial<LessonDef> = {}, l2: Partial<LessonDef> = {}) => family('f1', [lesson('f1-l1', 'Write the lesson file', l1), lesson('f1-l2', 'Write the lesson file twice', { supersedes: 'f1-l1', ...l2 })]);

async function run(s: ReturnType<typeof spec>, arms: string[], out: string, extra: RunExtra = {}) {
  return runAll({ spec: s, arms, seeds: 1, outDir: out, model: null, claudeBin: CLAUDE, settleMs: 0, warmup: false, log: () => {}, ...extra });
}
const readRecords = (out: string): Z0Record[] => readFileSync(join(out, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const readPlan = (out: string): Z0PlanCell[] => JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8'));
const logLines = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
const checkLog = (log: string): CheckLine[] => logLines(log).filter((l) => l.startsWith('check ')).map((l) => JSON.parse(l.slice(6)));
const seen = (out: string, arm: string, id: string): Record<string, string> => JSON.parse(readFileSync(join(out, 'raw', 'seqF', arm, 'seed1', `${id}.json`), 'utf8')).files;
const find = (recs: Z0Record[], arm: string, id: string) => recs.find((x) => x.arm === arm && x.taskId === id)!;
const workDir = (out: string, arm: string) => join(out, 'runs', 'seqF', arm, 'seed1', 'work');
const ZERO = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
const INVALID_NULLS: readonly (keyof Z0Record)[] = ['usage', 'costUsd', 'turns', 'toolCalls', 'fileReads', 'wallMs', 'teachTurns', 'correctionTurns', 'acceptancePassed', 'teachForm'];

function expectInvalid(r: Z0Record, reason: string) {
  expect(r.invalid, r.taskId).toBe(reason);
  for (const f of INVALID_NULLS) expect(r[f], `${r.taskId} ${String(f)}`).toBeNull();
  expect(r).toMatchObject({ lessons: [], resolved: false, void: null });
  expect([true, false]).toContain(r.timedOut);
  expect([true, false]).toContain(r.leak);
  expect(Number.isInteger(r.limitRetries)).toBe(true);
}

describe('runner git', () => {
  it('holdPre, dropPre and stateCommit run no hook and read no global config', () => {
    isolate('rgit');
    const r = makeRepo();
    const hooks = tmp('z0-turns-hooks-');
    const marker = join(hooks, 'ran').replace(/\\/g, '/');
    writeFileSync(join(hooks, 'reference-transaction'), `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
    const cfg = join(hooks, 'gitconfig');
    writeFileSync(cfg, `[core]\n\thooksPath = ${hooks.replace(/\\/g, '/')}\n[i18n]\n\tcommitEncoding = ISO-8859-1\n`);
    process.env.GIT_CONFIG_GLOBAL = cfg;
    // The control: plain git under this config does run the hook.
    execFileSync('git', ['update-ref', 'refs/z0/probe', r.base], { cwd: r.repo });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    holdPre(r.repo, r.base);
    dropPre(r.repo);
    const sha = stateCommit(r.repo, r.base);
    expect(existsSync(marker)).toBe(false);
    expect(execFileSync('git', ['cat-file', '-p', sha], { cwd: r.repo, encoding: 'utf8' })).not.toMatch(/^encoding /m);
  });

  it('stateCommit keeps a tracked edit outside a sparse-checkout cone the agent turned on', () => {
    isolate('sparse');
    const r = makeRepo();
    execFileSync('git', ['config', 'core.sparseCheckout', 'true'], { cwd: r.repo });
    mkdirSync(join(r.repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(r.repo, '.git', 'info', 'sparse-checkout'), '/elsewhere/\n');
    writeFileSync(join(r.repo, 'lib.js'), 'edited outside the cone\n');
    const sha = stateCommit(r.repo, r.base);
    expect(execFileSync('git', ['show', `${sha}:lib.js`], { cwd: r.repo, encoding: 'utf8' })).toBe('edited outside the cone\n');
  });

  it("a checker's own git status runs no core.fsmonitor program from the workspace config", () => {
    isolate('fsmon');
    const r = makeRepo();
    const d = tmp('z0-turns-fsmon-');
    const marker = join(d, 'ran').replace(/\\/g, '/');
    const script = join(d, 'fsmon.sh');
    writeFileSync(script, `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.fsmonitor', script.replace(/\\/g, '/')], { cwd: r.repo });
    // The control: plain git status in the workspace does run it.
    execFileSync('git', ['status', '--porcelain'], { cwd: r.repo });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    const check = join(d, 'status.mjs');
    // Exit 2 (a broken checker) if the runner clobbered the caller's own GIT_CONFIG_PARAMETERS.
    writeFileSync(check, [
      "import { spawnSync } from 'node:child_process';",
      "if (!(process.env.GIT_CONFIG_PARAMETERS ?? '').includes('color.ui=never')) process.exit(2);",
      "process.exit(spawnSync('git', ['status', '--porcelain']).status === 0 ? 0 : 2);",
    ].join('\n'));
    const l = { id: 'x-l1', checkPath: check, check: { script: 'status.mjs', args: [] } };
    const env = { ...process.env, GIT_CONFIG_PARAMETERS: "'color.ui=never'" };
    expect(runCheck(l, { work: r.repo, env, preCommit: r.base, postCommit: r.fix, commands: [], scratch: join(d, 'scratch') })).toBe('pass');
    expect(existsSync(marker)).toBe(false);
  });

  it("a checker's own git status runs no filter driver from the workspace config, a required one included", () => {
    isolate('filter');
    const r = makeRepo();
    const d = tmp('z0-turns-filter-');
    const marker = join(d, 'ran').replace(/\\/g, '/');
    execFileSync('git', ['config', "filter.z0'agent.clean", `sh -c 'echo ran >> "${marker}"; cat'`], { cwd: r.repo });
    execFileSync('git', ['config', "filter.z0'agent.required", 'true'], { cwd: r.repo });
    writeFileSync(join(r.repo, '.gitattributes'), "* filter=z0'agent\n");
    // Same bytes, a new mtime: status must read the file through the filter to see it is unchanged.
    const restat = () => {
      writeFileSync(join(r.repo, 'lib.js'), readFileSync(join(r.repo, 'lib.js')));
      utimesSync(join(r.repo, 'lib.js'), new Date(), new Date(Date.now() + 60_000));
    };
    restat();
    // The control: plain git status in the workspace does run it.
    execFileSync('git', ['status', '--porcelain'], { cwd: r.repo });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    restat();
    const check = join(d, 'status.mjs');
    writeFileSync(check, "import { spawnSync } from 'node:child_process';\nprocess.exit(spawnSync('git', ['status', '--porcelain']).status === 0 ? 0 : 2);\n");
    const l = { id: 'x-l1', checkPath: check, check: { script: 'status.mjs', args: [] } };
    expect(runCheck(l, { work: r.repo, env: process.env, preCommit: r.base, postCommit: r.fix, commands: [], scratch: join(d, 'scratch') })).toBe('pass');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('transcript reads across turns', () => {
  it('commandLog and transcriptWork count each tool_use once across files and session ids', () => {
    const dir = tmp('z0-turns-tx-');
    const use = (id: string, name: string, command?: string) => JSON.stringify({ message: { content: [{ type: 'tool_use', id, name, input: command ? { command } : {} }] } });
    const lines = [use('a1', 'Bash', 'echo one'), use('a2', 'Read'), use('a3', 'Bash', 'cat x'), use('a1', 'Bash', 'echo one'), use('b1', 'Bash', 'echo two'), use('b2', 'PowerShell', 'Get-Content y')];
    const file = join(dir, 's.jsonl');
    const copy = join(dir, 'copy.jsonl');
    writeFileSync(file, lines.join('\n'));
    writeFileSync(copy, lines.join('\n'));
    expect(records.commandLog([file, file])).toEqual(['echo one', 'cat x', 'echo two', 'Get-Content y']);
    expect(records.commandLog([file, copy])).toHaveLength(4);
    expect(records.transcriptWork([file, file], new Set())).toMatchObject({ toolCalls: 5, fileReads: 3, shellReads: 2 });
    expect(records.transcriptWork([file, copy], new Set())).toMatchObject({ toolCalls: 5 });
    expect(records.transcriptWork([], new Set())).toMatchObject({ toolCalls: null, fileReads: null });
  });
});

describe('Z0 lesson tasks end to end (fake Claude Code)', () => {
  it('runs a reversal family in all five arms; every record meets the z0-record/1 contract', async () => {
    const { out, log } = isolate('e2e');
    const r = makeRepo();
    const s = spec(r, [reversal()], [
      teach(r, 't1', 'f1-l1', 'LESSON_OK'), plain(r, 'n1'), task(r, 'n2', 'FIX add in lib.js'), apply(r, 'a1', 'f1-l1', 'LESSON_BAD\nRUN_CMD npm run lint'),
      teach(r, 't2', 'f1-l2', 'LESSON_BAD'), plain(r, 'n3'), plain(r, 'n4'), apply(r, 'a3', 'f1-l2', 'LESSON_OK'),
    ]);
    await run(s, ['A0', 'A1', 'A2', 'A4', 'A5'], out);
    const recs = readRecords(out);
    expect(recs).toHaveLength(40);
    const plan = readPlan(out);
    expect(validateCorpus(recs, plan)).toEqual([]);
    const cells = (xs: Z0PlanCell[]) => xs.map((x) => JSON.stringify([x.seed, x.position, x.arm, x.sequence, x.taskId, x.set, x.kind, x.familyId])).sort();
    expect(cells(plan)).toEqual(cells(recs));
    for (const arm of ['A0', 'A1', 'A2', 'A4', 'A5']) {
      const get = (id: string) => find(recs, arm, id);
      expect(get('t1'), arm).toMatchObject({ kind: 'teach', set: 'R', teachTurns: 1, correctionTurns: 0, teachForm: 'confirmation', lessons: [{ lessonId: 'f1-l1', first: 'pass', final: 'pass', staleFollow: null }] });
      expect(get('t1').usage.extra.outputTokens, arm).toBeGreaterThan(0);
      expect(get('t2'), arm).toMatchObject({ teachForm: 'correction', lessons: [{ lessonId: 'f1-l2', first: 'fail', final: 'pass' }] });
      expect(get('a1'), arm).toMatchObject({ kind: 'apply', applyIndex: 1, afterReversal: false, tasksSinceTeach: 2, teachTurns: 0, correctionTurns: 1, teachForm: null, lessons: [{ first: 'fail', final: 'pass', staleFollow: null }] });
      expect(get('a3'), arm).toMatchObject({ applyIndex: 2, afterReversal: true, tasksSinceTeach: 2, lessons: [{ lessonId: 'f1-l2', staleFollow: true }] });
      expect(get('n2'), arm).toMatchObject({ set: 'N', lessons: [], acceptancePassed: true, resolved: true, usage: { extra: ZERO } });
      for (const x of recs.filter((y) => y.arm === arm)) {
        expect(x.resolved, x.taskId).toBe(x.acceptancePassed && x.lessons.every((l) => l.final === 'pass') && !x.timedOut);
        expect('wordOverlap' in x, x.taskId).toBe(x.kind === 'apply');
        expect('scored' in x).toBe(false);
      }
    }
    // Z0_COMMANDS: session one's commands at the first check, then the correction turn's too at the final check.
    const a1Checks = checkLog(log).filter((c) => c.commands.includes('npm run lint'));
    expect(a1Checks).toHaveLength(10);
    for (const c of a1Checks) expect(c.commands.slice(0, 2)).toEqual(['git status && cat lib.js', 'npm run lint']);
    expect(a1Checks.filter((c) => c.commands.length === 3).map((c) => c.commands[2])).toEqual(Array(5).fill('echo resumed No:'));
  }, 600_000);

  it('a checker diffs Z0_PRE_COMMIT against Z0_POST_COMMIT: unstaged new files count, runner writes never do', async () => {
    const { out } = isolate('diff');
    const r = makeRepo();
    const want = family('f1', [lesson('f1-l1', 'Add a changelog fragment', { check: { script: 'diff.mjs', args: ['want=changelog.d/x.md'] } })]);
    await run(spec(r, [want], [teach(r, 't1', 'f1-l1', 'NEW_FILE changelog.d/x.md'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'NEW_FILE changelog.d/x.md'), apply(r, 'a2', 'f1-l1', 'look around only')]), ['A0'], out);
    const a = readRecords(out);
    expect(find(a, 'A0', 't1').lessons[0].first).toBe('pass');
    expect(find(a, 'A0', 'a1').lessons[0].first).toBe('pass');
    expect(find(a, 'A0', 'a2').lessons[0].first).toBe('fail');

    const out2 = tmp('z0-turns-out-diff2-');
    const quiet = family('f1', [lesson('f1-l1', 'Leave instruction files alone', { check: { script: 'diff.mjs', args: [] } })]);
    await run(spec(r, [quiet], [plain(r, 'c0'), teach(r, 't1', 'f1-l1', 'look around only'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'CARRY')].map((t) => (t.id === 'c0' ? { ...t, prompt: 'CARRY' } : t))), ['A1', 'A2', 'A4'], out2);
    const b = readRecords(out2);
    for (const arm of ['A1', 'A2', 'A4']) {
      expect(find(b, arm, 't1').lessons[0].first, arm).toBe('pass');
      expect(find(b, arm, 'a1').lessons[0].first, arm).toBe('pass');
      expect(find(b, arm, 'a2').lessons[0].first, arm).toBe('fail');
    }
    expect(seen(out2, 'A1', 't1')['.claude/rules/r.md']).toBe('carried rule\n');
    expect(seen(out2, 'A1', 't1')['AGENTS.md']).toContain('carried agents note');
    expect(seen(out2, 'A2', 't1')['CLAUDE.md']).toContain('hippo:start');
    expect(seen(out2, 'A4', 'a1')['CLAUDE.md']).toContain('- Leave instruction files alone, because the f1-l1 checker reads it.');
  }, 300_000);

  it('no resume after a passing apply, no checker on a no-lesson task, the message byte for byte, staleFollow both ways', async () => {
    const { out, log } = isolate('neg');
    const r = makeRepo();
    const fam = reversal({ rule: 'Write the stale file for the café menu', check: { script: 'lesson.mjs', args: ['file=stale.txt'] } });
    await run(spec(r, [fam], [
      teach(r, 't1', 'f1-l1', 'NEW_FILE stale.txt'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'NEW_FILE stale.txt'),
      teach(r, 't2', 'f1-l2', 'LESSON_OK'), plain(r, 'n3'), plain(r, 'n4'), apply(r, 'a3', 'f1-l2', 'LESSON_OK\nNEW_FILE stale.txt'), apply(r, 'a4', 'f1-l2', 'LESSON_OK'),
    ]), ['A0'], out);
    const recs = readRecords(out);
    const a1 = find(recs, 'A0', 'a1');
    expect(a1).toMatchObject({ correctionTurns: 0, usage: { extra: ZERO }, lessons: [{ first: 'pass', final: 'pass' }] });
    expect(logLines(log).filter((l) => l === `resume ${a1.sessionId}`)).toEqual([]);
    expect(checkLog(log)).toHaveLength(9);
    const sent = logLines(log).find((l) => l.startsWith('resume-msg '))!.slice('resume-msg '.length);
    expect(Buffer.from(sent, 'base64').equals(Buffer.from(teachMessage(fam.lessons[0], 'confirmation'), 'utf8'))).toBe(true);
    expect(find(recs, 'A0', 'a3').lessons[0].staleFollow).toBe(true);
    expect(find(recs, 'A0', 'a4').lessons[0].staleFollow).toBe(false);
  }, 300_000);

  it('end-of-task steps run after the last turn: a resume-written line carries, and hippo settles before the resume and at the end', async () => {
    const { out } = isolate('carry');
    const r = makeRepo();
    const fam = family('f1', [lesson('f1-l1', 'Write the lesson file')]);
    await run(spec(r, [fam], [teach(r, 't1', 'f1-l1', 'LESSON_OK\nWRITE_ON_RESUME taught-line-xyz'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only')]), ['A1', 'A2'], out);
    for (const arm of ['A1', 'A2']) {
      expect(seen(out, arm, 't1')['CLAUDE.md'], arm).not.toContain('taught-line-xyz');
      for (const id of ['n1', 'n2']) expect(seen(out, arm, id)['CLAUDE.md'], `${arm} ${id}`).toContain('taught-line-xyz');
    }
    expect(seen(out, 'A2', 'n2')['CLAUDE.md']).toContain('hippo:start');
    const settle = readFileSync(join(out, 'runs', 'seqF', 'A2', 'seed1', 'settle.log'), 'utf8').trim().split('\n');
    expect(settle).toEqual(['t1 pre-resume', 't1 end', 'n1 end', 'n2 end', 'a1 end', 'a2 end']);
    expect(existsSync(join(out, 'runs', 'seqF', 'A1', 'seed1', 'settle.log'))).toBe(false);
  }, 300_000);
});

describe('A4 and invalid shapes', () => {
  it('A4 holds each taught lesson in CLAUDE.md from the next task on, a reversal replaces it, A0 never', async () => {
    const { out } = isolate('a4');
    const r = makeRepo();
    const fam = reversal();
    const s = spec(r, [fam], [
      teach(r, 't1', 'f1-l1', 'LESSON_OK'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK'),
      teach(r, 't2', 'f1-l2', 'LESSON_OK'), plain(r, 'n3'), plain(r, 'n4'), apply(r, 'a3', 'f1-l2', 'LESSON_OK'),
    ]);
    await run(s, ['A0', 'A4'], out);
    const line = (l: LessonDef) => `\n- ${l.rule}, because ${l.reason}.\n`;
    const [l1, l2] = fam.lessons;
    expect(seen(out, 'A4', 't1')['CLAUDE.md']).toBe(STUB_CLAUDE_MD);
    for (const id of ['n1', 'n2', 'a1', 't2']) expect(seen(out, 'A4', id)['CLAUDE.md'], id).toBe(STUB_CLAUDE_MD + line(l1));
    for (const id of ['n3', 'n4', 'a3']) expect(seen(out, 'A4', id)['CLAUDE.md'], id).toBe(STUB_CLAUDE_MD + line(l2));
    for (const id of ['t1', 'n1', 'a1', 'a3']) expect(seen(out, 'A0', id)['CLAUDE.md'], id).toBe(STUB_CLAUDE_MD);
    const steps = planRuns(s, ['A0', 'A1', 'A2', 'A4', 'A5']);
    const a4Seeds = new Set(steps.filter((x) => x.arm === 'A4').map((x) => x.seed));
    expect([...a4Seeds].sort()).toEqual([1, 2]);
  }, 300_000);

  it('A4 is told a lesson only when its teach resume gave a result; invalid teach records leave their applies unchecked', async () => {
    const { out, log } = isolate('a4inv');
    const r = makeRepo();
    const fams = ['fA', 'fB', 'fC'].map((f) => family(f, [lesson(`${f}-l1`, `Write the ${f} file`, f === 'fB' ? { check: { script: 'lesson.mjs', args: ['exit=2'] } } : {})]));
    const s = spec(r, fams, [
      teach(r, 'tA', 'fA-l1', 'LESSON_OK NO_RESULT_ON_RESUME'), teach(r, 'tB', 'fB-l1', 'LESSON_OK'), teach(r, 'tC', 'fC-l1', 'LESSON_OK NOTRANSCRIPT'),
      apply(r, 'aA1', 'fA-l1', 'look around only'), apply(r, 'aB1', 'fB-l1', 'look around only'), apply(r, 'aC1', 'fC-l1', 'look around only'),
      apply(r, 'aA2', 'fA-l1', 'look around only'), apply(r, 'aB2', 'fB-l1', 'look around only'), apply(r, 'aC2', 'fC-l1', 'look around only'),
    ]);
    await run(s, ['A4'], out);
    const recs = readRecords(out);
    const md = seen(out, 'A4', 'aA1')['CLAUDE.md'];
    expect(md).not.toContain('Write the fA file');
    expect(md).toContain('- Write the fB file, because');
    expect(md).toContain('- Write the fC file, because');
    expectInvalid(find(recs, 'A4', 'tA'), 'resume');
    expectInvalid(find(recs, 'A4', 'tB'), 'checker');
    expectInvalid(find(recs, 'A4', 'tC'), 'no-transcript');
    expect(logLines(log)).toContain(`resume ${find(recs, 'A4', 'tB').sessionId}`);
    const aB1 = find(recs, 'A4', 'aB1');
    expectInvalid(aB1, 'checker');
    expect(logLines(log).filter((l) => l === `resume ${aB1.sessionId}`)).toEqual([]);
    expect(existsSync(join(out, 'raw', 'seqF', 'A4', 'seed1', 'aB1.checker.txt'))).toBe(true);
    expect(validateCorpus(recs, readPlan(out)).sort()).toEqual(['aA1', 'aA2', 'aB1', 'aB2', 'aC1', 'aC2']);
  }, 300_000);

  it('no-result and setup shapes carry the full field set; a crashed teach leaves its applies unchecked', async () => {
    const { out } = isolate('shapes');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'CRASH'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK', { setup: 'exit 1' }), apply(r, 'a2', 'f1-l1', 'LESSON_OK'),
    ]);
    await run(s, ['A1'], out);
    const recs = readRecords(out);
    expectInvalid(find(recs, 'A1', 't1'), 'no-result');
    const a1 = find(recs, 'A1', 'a1');
    expectInvalid(a1, 'setup');
    expect(a1).toMatchObject({ carryUnionMerges: null, kind: 'apply', familyId: 'f1', lessonId: 'f1-l1', applyIndex: 1 });
    expect(validateCorpus(recs, readPlan(out)).sort()).toEqual(['a1', 'a2']);
  }, 300_000);
});

describe('an agent that breaks its workspace git', () => {
  it('an orphan HEAD or a deleted .git makes that cell invalid: workspace, and the run goes on', async () => {
    const { out, log } = isolate('broken-git');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_OK ORPHAN'), task(r, 'n1', 'RM_GIT'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_BAD RM_GIT'), apply(r, 'a2', 'f1-l1', 'LESSON_OK'),
    ]);
    await run(s, ['A0'], out);
    const recs = readRecords(out);
    expect(recs.map((x) => x.taskId)).toEqual(['t1', 'n1', 'n2', 'a1', 'a2']);
    for (const id of ['t1', 'n1', 'a1']) expectInvalid(find(recs, 'A0', id), 'workspace');
    expect(find(recs, 'A0', 'n2').invalid).toBeNull();
    expect(find(recs, 'A0', 'a2')).toMatchObject({ invalid: null, lessons: [{ first: 'pass', final: 'pass' }] });
    expect(logLines(log).filter((l) => l.startsWith('resume '))).toEqual([]);
    expect(readFileSync(join(out, 'raw', 'seqF', 'A0', 'seed1', 't1.workspace.txt'), 'utf8')).toMatch(/HEAD/);
    expect(validateCorpus(recs, readPlan(out)).sort()).toEqual(['a1', 'a2']);
  }, 300_000);
});

describe('an instruction file the agent leaves above work/', () => {
  const resumes = (log: string) => logLines(log).filter((l) => l.startsWith('resume ') && !l.startsWith('resume-'));
  const a4Md = (out: string) => readFileSync(join(workDir(out, 'A4'), 'CLAUDE.md'), 'utf8');
  const fam = () => family('f1', [lesson('f1-l1', 'Write the lesson file')]);

  it('voids an apply whatever its first check says', async () => {
    for (const first of ['LESSON_OK', 'LESSON_BAD']) {
      const { out, log } = isolate(`anc-apply-${first}`);
      const r = makeRepo();
      await run(spec(r, [fam()], [teach(r, 't1', 'f1-l1', 'LESSON_OK'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', `${first} ESCAPE`), apply(r, 'a2', 'f1-l1', 'LESSON_OK')]), ['A4'], out);
      const recs = readRecords(out);
      expectInvalid(find(recs, 'A4', 'a1'), 'ancestor-instructions');
      expect(resumes(log).filter((l) => l === `resume ${find(recs, 'A4', 'a1').sessionId}`), first).toEqual([]);
      expect(find(recs, 'A4', 'a2').invalid).toBe('ancestor-instructions');
    }
  }, 300_000);

  it('a teach that plants one takes no resume and A4 is not taught', async () => {
    const { out, log } = isolate('anc-teach');
    const r = makeRepo();
    await run(spec(r, [fam()], [teach(r, 't1', 'f1-l1', 'LESSON_OK ESCAPE'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK'), apply(r, 'a2', 'f1-l1', 'LESSON_OK')]), ['A4'], out);
    expect(resumes(log)).toEqual([]);
    expect(a4Md(out)).not.toContain('Write the lesson file');
    expectInvalid(find(readRecords(out), 'A4', 't1'), 'ancestor-instructions');
  }, 300_000);

  it('one a cut-off resume plants stops the rerun, keeps the retry count, and A4 is not taught', async () => {
    const { out, log } = isolate('anc-cut');
    const r = makeRepo();
    await run(spec(r, [fam()], [teach(r, 't1', 'f1-l1', 'LESSON_BAD CUT_ON_RESUME ANCESTOR_ON_CUT'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK'), apply(r, 'a2', 'f1-l1', 'LESSON_OK')]), ['A4'], out, { limitWaitMs: 0 });
    const t1 = find(readRecords(out), 'A4', 't1');
    expectInvalid(t1, 'ancestor-instructions');
    expect(t1.limitRetries).toBe(1);
    expect(resumes(log)).toEqual([`resume ${t1.sessionId}`]);
    expect(a4Md(out)).not.toContain('Write the lesson file');
    expect(existsSync(join(out, 'raw', 'seqF', 'A4', 'seed1', 't1.ancestor.txt'))).toBe(true);
  }, 300_000);

  it('a clean filter the agent set never runs when the runner snapshots for the check, so the cell grades normally', async () => {
    const { out, log } = isolate('anc-filter');
    const r = makeRepo();
    await run(spec(r, [fam()], [teach(r, 't1', 'f1-l1', 'LESSON_BAD CLEAN_FILTER_PLANT'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK'), apply(r, 'a2', 'f1-l1', 'LESSON_OK')]), ['A4'], out);
    expect(existsSync(join(workDir(out, 'A4'), '..', 'CLAUDE.md'))).toBe(false);
    const recs = readRecords(out);
    const t1 = find(recs, 'A4', 't1');
    expect(t1).toMatchObject({ invalid: null, lessons: [{ first: 'fail', final: 'pass' }] });
    expect(resumes(log)).toEqual([`resume ${t1.sessionId}`]);
    expect(find(recs, 'A4', 'a1').invalid).toBeNull();
  }, 300_000);

  it('one a checker writes is caught right before the resume: no resume, and A4 is not taught', async () => {
    const { out, log } = isolate('anc-checker');
    const r = makeRepo();
    const escaping = family('f1', [lesson('f1-l1', 'Write the lesson file', { check: { script: 'lesson.mjs', args: ['escape'] } })]);
    await run(spec(r, [escaping], [teach(r, 't1', 'f1-l1', 'LESSON_BAD'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK'), apply(r, 'a2', 'f1-l1', 'LESSON_OK')]), ['A4'], out);
    expectInvalid(find(readRecords(out), 'A4', 't1'), 'ancestor-instructions');
    expect(resumes(log)).toEqual([]);
    expect(a4Md(out)).not.toContain('Write the lesson file');
  }, 300_000);
});

describe('session evidence', () => {
  it('Z0_COMMANDS and the work counts take in subagent transcripts', async () => {
    const { out, log } = isolate('subagent');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_BAD\nSUBAGENT_CMD npm run lint'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]);
    await run(s, ['A0'], out);
    const recs = readRecords(out);
    const checks = checkLog(log).filter((c) => c.lesson === 'f1-l1');
    expect(checks[0].commands).toEqual(['git status && cat lib.js', 'npm run lint']);
    expect(checks[1].commands).toEqual(['git status && cat lib.js', 'echo resumed No:', 'npm run lint']);
    // Session 1 makes 3 tool calls, its subagent 1 and the resume 1.
    expect(find(recs, 'A0', 'n1').toolCalls).toBe(3);
    expect(find(recs, 'A0', 't1').toolCalls).toBe(5);
  }, 300_000);

  it('raw session and resume JSON stay whole past 20,000 characters; a result with no session id is no-transcript', async () => {
    const { out, log } = isolate('raw');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')]), family('f2', [lesson('f2-l1', 'Write the f2 file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_BAD BIG_RESULT'), teach(r, 't2', 'f2-l1', 'LESSON_OK NO_SESSION_ID'), task(r, 'n1', 'NO_SESSION_ID'), plain(r, 'n2'),
      apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'b1', 'f2-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'), apply(r, 'b2', 'f2-l1', 'look around only'),
    ]);
    await run(s, ['A0'], out);
    const raw = (name: string) => JSON.parse(readFileSync(join(out, 'raw', 'seqF', 'A0', 'seed1', name), 'utf8'));
    expect(raw('t1.json').pad).toHaveLength(30_000);
    expect(raw('t1.resume.json').pad).toHaveLength(30_000);
    const recs = readRecords(out);
    expectInvalid(find(recs, 'A0', 't2'), 'no-transcript');
    expectInvalid(find(recs, 'A0', 'n1'), 'no-transcript');
    expect(logLines(log).filter((l) => l.startsWith('resume ') && !l.startsWith('resume-'))).toEqual([`resume ${find(recs, 'A0', 't1').sessionId}`]);
  }, 300_000);

  it('the hippo field sums the ledger over both turns when the resume has its own session id', async () => {
    const { out } = isolate('hippo-sum');
    const r = makeRepo();
    // n0 stores a memory first, so the hook injects on both of t1's turns.
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      task(r, 'n0', 'FIX add in lib.js'), teach(r, 't1', 'f1-l1', 'LESSON_OK NEW_ID_ON_RESUME'),
      plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]);
    await run(s, ['A2'], out);
    const t1 = find(readRecords(out), 'A2', 't1');
    expect(t1.resumeSessionId).not.toBe(t1.sessionId);
    const lib = await loadHippo();
    const db = lib.openHippoDb(join(workDir(out, 'A2'), '.hippo'));
    const rows = lib.tokensBySession(db, 'default', '1970-01-01T00:00:00.000Z').filter((x: { sessionId: string }) => [t1.sessionId, t1.resumeSessionId].includes(x.sessionId));
    lib.closeHippoDb(db);
    expect(rows).toHaveLength(2);
    for (const x of rows) expect(x.injections, x.sessionId).toBeGreaterThan(0);
    const total = (k: 'sent' | 'skipped' | 'injections') => rows.reduce((n: number, x: Record<string, number>) => n + x[k], 0);
    expect(t1.hippo).toEqual({ sessionId: t1.sessionId, sent: total('sent'), skipped: total('skipped'), injections: total('injections') });
  }, 300_000);
});

describe('usage limits around resumes', () => {
  const limitSpec = (r: FixtureRepo, extra: string) => spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file', { check: { script: 'lesson.mjs', args: ['probe'] } })])], [
    teach(r, 't1', 'f1-l1', `LESSON_BAD CUT_ON_RESUME COMMIT_ON_RESUME STAGE_EDIT a.txt NEW_FILE kept.txt${extra}`), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
  ]);

  for (const variant of ['detached', 'branch']) {
    it(`a cut-off resume puts back the post-session-1 state exactly and reruns from the same session (${variant} HEAD)`, async () => {
      const { out, log } = isolate(`cut-${variant}`);
      const r = makeRepo();
      await run(limitSpec(r, `${variant === 'branch' ? ' ON_BRANCH' : ''} CUT_SUBAGENT`), ['A0'], out, { limitWaitMs: 0 });
      const t1 = find(readRecords(out), 'A0', 't1');
      expect(t1).toMatchObject({ invalid: null, limitRetries: 1, resumeSessionId: t1.sessionId, lessons: [{ first: 'fail', final: 'pass' }] });
      const lines = logLines(log);
      expect(lines.filter((l) => l === 'cutoff-written')).toHaveLength(1);
      expect(lines.filter((l) => l.startsWith('resume ') && !l.startsWith('resume-'))).toEqual([`resume ${t1.sessionId}`, `resume ${t1.sessionId}`]);
      const bytes = lines.filter((l) => l.startsWith('transcript-bytes '));
      expect(bytes).toHaveLength(2);
      expect(bytes[0]).toBe(bytes[1]);
      expect(existsSync(join(out, 'raw', 'seqF', 'A0', 'seed1', 't1.resume-limit1.txt'))).toBe(true);
      const final = checkLog(log)[1];
      expect(final).toMatchObject({
        head: t1.baseCommit, cutoffOnDisk: false, cutoffStaged: false, cachedStatus: 0, stagedA: 'v1', diskA: 'v2', kept: true,
        claudeMd: STUB_CLAUDE_MD, cutCommitAlive: false, preRef: final.pre,
      });
      expect(final.commands).not.toContain('echo cut-off subagent');
      expect(final.logAll).not.toContain('cutoff');
      expect(final.reflog ?? '').not.toContain('cutoff');
      expect(final.refs).not.toContain('refs/z0/resume-snap');
      if (variant === 'branch') expect(final).toMatchObject({ symbolic: 'refs/heads/work', work: t1.baseCommit });
      else expect(final.symbolic).toBeNull();
    }, 300_000);
  }

  it('restoring after a cut-off resume runs no smudge filter the agent set', async () => {
    const { out } = isolate('cut-smudge');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_BAD CUT_ON_RESUME SMUDGE_FILTER'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]);
    await run(s, ['A0'], out, { limitWaitMs: 0 });
    expect(find(readRecords(out), 'A0', 't1')).toMatchObject({ invalid: null, limitRetries: 1, lessons: [{ first: 'fail', final: 'pass' }] });
    expect(existsSync(join(workDir(out, 'A0'), '..', 'smudge-ran.txt'))).toBe(false);
  }, 300_000);

  it('wallMs leaves out a cut-off resume attempt, its wait and its reset', async () => {
    const { out } = isolate('wall');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_BAD CUT_ON_RESUME CUT_SLEEP_MS=5000'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]);
    await run(s, ['A0'], out, { limitWaitMs: 5000 });
    const t1 = find(readRecords(out), 'A0', 't1');
    expect(t1).toMatchObject({ invalid: null, limitRetries: 1, lessons: [{ first: 'fail', final: 'pass' }] });
    // The cut-off attempt and the wait take 10 s between them; the turns that count take well under 5 s.
    expect(t1.wallMs).toBeLessThan(5000);
  }, 300_000);

  it('a resume that runs out of time marks the record timed out', async () => {
    const { out } = isolate('resume-timeout');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_OK RESUME_HANG_MS=40000'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]);
    await run(s, ['A0'], out, { sessionTimeoutMs: 15_000 });
    const recs = readRecords(out);
    expect(find(recs, 'A0', 't1')).toMatchObject({ timedOut: true, resolved: false });
    expect(find(recs, 'A0', 'n1').timedOut).toBe(false);
  }, 300_000);

  it('a resume limit that outlasts every wait abandons the run and leaves no z0 ref behind', async () => {
    const { out } = isolate('cut-abandon');
    const r = makeRepo();
    await expect(run(limitSpec(r, ''), ['A0'], out, { limitWaitMs: 0, limitMaxWaits: 0 })).rejects.toThrow(/seqF t1 A0 seed1: still at the plan limit after 0 waits/);
    const refs = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/z0'], { cwd: workDir(out, 'A0'), encoding: 'utf8' });
    expect(refs.trim()).toBe('');
  }, 120_000);

  it('a plan limit that outlasts every wait still names the limit when the limited attempt also deleted .git', async () => {
    const { out } = isolate('limit-rmgit');
    const r = makeRepo();
    process.env.FAKE_CLAUDE_LIMIT_ALWAYS = '1';
    const logs: string[] = [];
    const s = spec(r, [], [task(r, 't1', 'LIMIT RM_GIT look around'), plain(r, 'n1')]);
    await expect(run(s, ['A0'], out, { limitWaitMs: 0, limitMaxWaits: 0, log: (m) => logs.push(m) })).rejects.toThrow(/seqF t1 A0 seed1: still at the plan limit after 0 waits/);
    expect(logs.some((m) => /runner git on the agent's workspace failed/.test(m))).toBe(true);
  }, 120_000);

  it('a session-1 retry rebuilds Z0_PRE_COMMIT, and the held ref keeps nothing reachable after the task', async () => {
    const { out, log } = isolate('retry');
    const r = makeRepo();
    const newer = stubBaseCommit(r.repo, r.fix);
    process.env.FAKE_CLAUDE_LIMIT_ONCE = join(out, 'limit-hit');
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file', { check: { script: 'lesson.mjs', args: [`has=${newer}`] } })])], [
      teach(r, 't1', 'f1-l1', 'LIMIT LESSON_BAD', { baseRef: r.fix }), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only'),
    ]);
    const said: string[] = [];
    await run(s, ['A2'], out, { limitWaitMs: 0, log: (m: string) => said.push(m) });
    const t1 = find(readRecords(out), 'A2', 't1');
    expect(t1).toMatchObject({ invalid: null, limitRetries: 1, baseCommit: newer, lessons: [{ first: 'fail', final: 'pass' }] });
    expect(said.some((m) => /t1 A2 seed1: Z0_PRE_COMMIT rebuilt/.test(m))).toBe(true);
    expect(seen(out, 'A2', 't1')['CLAUDE.md']).toContain('hippo:start');
    const checks = checkLog(log);
    for (const c of checks) expect(c.preRef).toBe(c.pre);
    expect(checks.slice(0, 2).map((c) => c.has)).toEqual([true, true]);
    expect(checks.slice(2).map((c) => c.has)).toEqual(Array(checks.length - 2).fill(false));
    const refs = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/z0'], { cwd: workDir(out, 'A2'), encoding: 'utf8' });
    expect(refs.trim()).toBe('');
  }, 300_000);
});

describe('drawn order in the plan', () => {
  it('plan cells follow the drawn order per seed and carry kind, familyId and set; the dry run prints orders and spacing', () => {
    const file = join(CHECKS, 'toy-tasks.json');
    const s = validateTasks(JSON.parse(readFileSync(file, 'utf8')), CHECKS);
    const steps = planRuns(s, ['A0', 'A4'], () => 2);
    for (const seed of [1, 2]) {
      const order = drawOrder(s.sequences[0], s.families, seed);
      for (const st of steps.filter((x) => x.seed === seed)) expect(st.taskId).toBe(order[st.position]);
    }
    const out = tmp('z0-turns-dry-');
    const res = spawnSync(process.execPath, [resolve(__dirname, '..', 'scripts', 'token-eval', 'ab-run.mjs'), '--tasks', file, '--out', out, '--dry-run', '--arms', 'A0,A4'], { encoding: 'utf8', env: { ...process.env, Z0_ANCESTOR_STOP: out } });
    expect(res.status, res.stderr).toBe(0);
    const plan = readPlan(out);
    for (const c of plan) {
      const t = s.sequences[0].tasks.find((x) => x.id === c.taskId);
      expect(c).toMatchObject({ kind: t.kind, familyId: t.familyId ?? null, set: t.kind === 'no-lesson' ? 'N' : 'R' });
      expect(c.taskId).toBe(drawOrder(s.sequences[0], s.families, c.seed)[c.position]);
    }
    for (const seed of [1, 2]) expect(res.stdout).toContain(`order seqA seed${seed}: ${drawOrder(s.sequences[0], s.families, seed).join(' ')}`);
    expect(res.stdout).toMatch(/seqA tasksSinceTeach over 10 applies: min \d+, median \d+(\.\d+)?, max \d+/);
  });
});

describe('family screen', () => {
  it('keeps, drops and leaves undecided from the first checks; A0 and A4 only, no resume', async () => {
    const { out, log } = isolate('screen');
    const r = makeRepo();
    const screened = (id: string, prompt: string, args: string[] = []): FamilyDef => ({
      ...family(id, [lesson(`${id}-l1`, `Write the ${id} file`, { check: { script: 'lesson.mjs', args } })]),
      screen: { id: `${id}-screen`, baseRef: r.base, fixRef: r.fix, prompt, test: 'node test.js', testFiles: ['test.js'] },
    });
    const ids = ['fK', 'fD', 'fU'];
    const s = spec(r, [screened('fK', 'LESSON_TOLD SEED2_OK'), screened('fD', 'LESSON_TOLD SEED2_BAD'), screened('fU', 'LESSON_TOLD', ['exit=5'])], [
      ...ids.map((f) => teach(r, `t${f}`, `${f}-l1`, 'LESSON_BAD')), plain(r, 'n1'), plain(r, 'n2'),
      ...ids.map((f) => apply(r, `a${f}1`, `${f}-l1`, 'look around only')), ...ids.map((f) => apply(r, `a${f}2`, `${f}-l1`, 'look around only')),
    ]);
    const v = await runScreen({ spec: s, outDir: out, claudeBin: CLAUDE, settleMs: 0, warmup: false, log: () => {} });
    expect(v.kept).toEqual(['fK']);
    expect(v.families.find((f: { familyId: string }) => f.familyId === 'fK')).toMatchObject({ a0Breaks: 3, a0Of: 4, a4Follows: 2, a4Of: 2 });
    expect(v.dropped).toEqual([{ familyId: 'fD', a0Breaks: 4, a0Of: 4, a4Follows: 1, a4Of: 2, verdict: 'dropped' }]);
    expect(v.undecided).toEqual([expect.objectContaining({ familyId: 'fU', verdict: 'undecided', reason: expect.stringMatching(/invalid checker$/) })]);
    expect(JSON.parse(readFileSync(join(out, 'screen.json'), 'utf8'))).toEqual(v);
    const recs: Z0Record[] = readFileSync(join(out, 'screen.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(recs).toHaveLength(18);
    expect([...new Set(recs.map((x) => x.arm))].sort()).toEqual(['A0', 'A4']);
    for (const x of recs) expect(x).toMatchObject({ kind: 'screen', screen: true, resumeSessionId: null });
    expect(recs.filter((x) => x.arm === 'A0').map((x) => x.taskId)).toEqual(expect.arrayContaining(['tfK', 'fK-screen']));
    expect(logLines(log).filter((l) => l.startsWith('resume-msg'))).toEqual([]);
    expect(existsSync(join(out, 'runs.jsonl'))).toBe(false);
  }, 300_000);

  it('a screen task with a symlinked instruction file stops the screen before any session', async () => {
    const { out, log } = isolate('screen-link');
    const r = makeRepo();
    const g = (...args: string[]): string => execFileSync('git', args, { cwd: r.repo, encoding: 'utf8' }).trim();
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: r.repo, input: 'policy.md', encoding: 'utf8' }).trim();
    g('update-index', '--add', '--cacheinfo', `120000,${blob},docs/AGENTS.md`);
    g('commit', '-qm', 'link');
    const fam = { ...family('fL', [lesson('fL-l1', 'Write the fL file')]), screen: { id: 'fL-screen', baseRef: g('rev-parse', 'HEAD'), fixRef: r.fix, prompt: 'x', test: 'node test.js', testFiles: ['test.js'] } };
    const s = spec(r, [fam], [teach(r, 'tL', 'fL-l1', 'LESSON_BAD'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'aL1', 'fL-l1', 'x'), apply(r, 'aL2', 'fL-l1', 'x')]);
    await expect(runScreen({ spec: s, outDir: out, claudeBin: CLAUDE, settleMs: 0, warmup: false, log: () => {} }))
      .rejects.toThrow('Z0 task seqF/fL-screen: instruction file docs/AGENTS.md is a symlink in the task repo');
    expect(logLines(log)).toEqual([]);
  }, 60_000);
});
