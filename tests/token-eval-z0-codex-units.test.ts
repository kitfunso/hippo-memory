// Z0 set X units: the tasks file, the plan, arm settings and env, the Codex args, rollout parser, waits and auth.
import { describe, it, expect, afterEach } from 'vitest';
import { delimiter, join } from 'node:path';
import { validateTasks, planRuns } from '../scripts/token-eval/ab-run.mjs';
import { armEnv, armSettings, ARM_SEEDS, HIPPO_ARMS, CARRY_ARMS } from '../scripts/token-eval/arms.mjs';
import { runDirs } from '../scripts/token-eval/homes.mjs';
import { parseWrapperWait } from '../scripts/token-eval/codex.mjs';
import { wrapperVerdict, wrapperWait } from '../scripts/token-eval/codex-task.mjs';
import { readIfPresent } from '../scripts/token-eval/codex-auth.mjs';
import { CHECKS, cleanup, tmp, lesson, family, task, teach, apply } from './fixtures/z0-harness.js';
import type { FixtureRepo, TaskDef } from './fixtures/z0-harness.js';

afterEach(cleanup);

const R: FixtureRepo = { repo: 'r', base: 'b', fix: 'f' };
interface SeqDef { id: string; cluster: string; repo: string; fixedOrder: boolean; set?: string; tasks: TaskDef[] }
interface Step { seed: number; position: number; arm: string; sequence: SeqDef; taskId: string; role: { kind: string; set: string } }

/** Three families on one sequence, every teach before its applies with two tasks between. */
function xFamilies(seq: string, prefix: string) {
  const ids = ['a', 'b', 'c'].map((k) => `${prefix}${k}`);
  const families = ids.map((id) => ({ ...family(id, [lesson(`${id}-l1`, `Rule ${id} holds`)]), sequence: seq }));
  const teaches = ids.map((id) => teach(R, `t-${id}`, `${id}-l1`, `teach ${id}`));
  const applies = ids.flatMap((id) => [apply(R, `x-${id}`, `${id}-l1`, `apply ${id}`), apply(R, `y-${id}`, `${id}-l1`, `again ${id}`)]);
  return { families, tasks: [...teaches, ...applies] };
}

function xSpec(withR = false) {
  const x = xFamilies('seqX', 'x');
  const sequences: SeqDef[] = [{ id: 'seqX', cluster: 'c', repo: 'r', fixedOrder: true, set: 'X', tasks: x.tasks }];
  const families = [...x.families];
  if (withR) {
    const r = xFamilies('seqR', 'r');
    sequences.push({ id: 'seqR', cluster: 'c', repo: 'r', fixedOrder: true, tasks: [...r.tasks, task(R, 'n1', 'plain')] });
    families.push(...r.families);
  }
  return { families, sequences };
}

describe('set X in the tasks file (test 1)', () => {
  it('accepts a sequence with set X and gives its tasks role set X', () => {
    const s = validateTasks(xSpec(), CHECKS);
    const steps: Step[] = planRuns(s, ['X1']);
    expect(steps.length).toBeGreaterThan(0);
    for (const st of steps) expect(st.role.set).toBe('X');
  });

  it('refuses a task-level set, naming the task', () => {
    for (const value of ['X', 'R']) {
      const s = xSpec();
      Object.assign(s.sequences[0].tasks[1], { set: value });
      expect(() => validateTasks(s, CHECKS)).toThrow(/task t-xb.*set belongs on the sequence/);
    }
  });

  it('refuses a no-lesson task in an X sequence, naming it', () => {
    const s = xSpec();
    s.sequences[0].tasks.push(task(R, 'n9', 'plain'));
    expect(() => validateTasks(s, CHECKS)).toThrow(/task n9.*no-lesson.*set X/);
  });

  it('refuses a sequence set other than X', () => {
    const s = xSpec();
    s.sequences[0].set = 'R';
    expect(() => validateTasks(s, CHECKS)).toThrow(/sequence seqX.*set/);
  });
});

describe('set X in the plan (test 2)', () => {
  it('pairs X arms with X sequences and A arms with R/N, with the prereg seeds', () => {
    const s = validateTasks(xSpec(true), CHECKS);
    const steps: Step[] = planRuns(s, ['A1', 'X1', 'X2', 'X3', 'X4']);
    for (const st of steps) expect(st.sequence.id, `${st.arm} on ${st.sequence.id}`).toBe(st.arm.startsWith('X') ? 'seqX' : 'seqR');
    const seeds = (arm: string) => new Set(steps.filter((st) => st.arm === arm).map((st) => st.seed)).size;
    expect([seeds('X1'), seeds('X2'), seeds('X3'), seeds('X4')]).toEqual([3, 3, 3, 2]);
    expect(ARM_SEEDS).toMatchObject({ X1: 3, X2: 3, X3: 3, X4: 2 });
    const firstX = (p: number) => steps.find((st) => st.seed === 1 && st.position === p && st.sequence.id === 'seqX')!.arm;
    expect(firstX(0)).not.toBe(firstX(1));
    expect(steps.filter((st) => st.sequence.id === 'seqR').every((st) => st.role.set !== 'X')).toBe(true);
  });

  it('refuses an arm with no sequence of its set, naming it', () => {
    expect(() => planRuns(validateTasks(xSpec(), CHECKS), ['X1', 'A1'])).toThrow(/A1.*no sequence of set R or N/);
    const rOnly = xSpec(true);
    rOnly.sequences.shift();
    rOnly.families = rOnly.families.filter((f) => f.sequence === 'seqR');
    expect(() => planRuns(validateTasks(rOnly, CHECKS), ['X1'])).toThrow(/X1.*no sequence of set X/);
  });
});

describe('X arm settings and env (test 3)', () => {
  const hippo = { hooks: { SessionEnd: [], UserPromptSubmit: [] } };
  it('gives X1, X3 and X4 auto memory on and X2 the hippo settings', () => {
    for (const arm of ['X1', 'X3', 'X4']) expect(armSettings(arm, hippo), arm).toEqual({});
    expect(armSettings('X2', hippo)).toEqual(hippo);
    expect([...HIPPO_ARMS].sort()).toEqual(['A2', 'A5', 'X2']);
    for (const arm of ['X1', 'X2', 'X3', 'X4']) expect(CARRY_ARMS.has(arm), arm).toBe(true);
  });

  it('strips OpenAI keys in every arm and puts bin/ first for X2 only', () => {
    const out = tmp('z0-xenv-');
    const base = { PATH: `/usr/bin${delimiter}/bin`, OPENAI_API_KEY: 'k1', openai_org_id: 'o1', KEEP_ME: 'k' };
    for (const arm of ['A1', 'X1', 'X2', 'X3', 'X4']) {
      const dirs = runDirs(out, 'seqX', arm, 1);
      const env = armEnv(arm, dirs, base);
      expect(env, arm).not.toHaveProperty('OPENAI_API_KEY');
      expect(env, arm).not.toHaveProperty('openai_org_id');
      expect(env.KEEP_ME).toBe('k');
      expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, arm).toBe('0');
      expect((env.PATH ?? '').split(delimiter)[0] === dirs.bin, arm).toBe(arm === 'X2');
    }
  });
});

describe('the wrapper\'s end line (R17)', () => {
  const ID = '0199a7c2-4d1e-7b30-9c55-2f6e8a41d0b7';
  const at = (text: string) => `[hippo] 2026-01-01T00:00:00.000Z ${text}`;
  const START = at('consolidating memory...');
  const wrote = (id: string) => at(`digest: wrote 1 sentence(s), 0 file(s) for rollout-x-${id}`);

  it('is captured when the digest line names this thread\'s rollout, and not when it names another', () => {
    const log = [START, 'Sleep done.', '[hippo] sleep complete', wrote(ID), ''].join('\r\n');
    expect(wrapperVerdict(log, ID)).toEqual({ done: true, captured: true, end: `digest: wrote 1 sentence(s), 0 file(s) for rollout-x-${ID}` });
    expect(wrapperVerdict(log, 'another-thread')).toMatchObject({ done: true, captured: false });
    expect(wrapperVerdict(log, null)).toMatchObject({ done: true, captured: false });
    expect(wrapperVerdict([START, at('digest: skip: no final message and no edits'), ''].join('\n'), ID)).toEqual({ done: true, captured: false, end: 'digest: skip: no final message and no edits' });
  });

  it('is not done on a progress line, nor on an end line with no start line above it', () => {
    expect(wrapperVerdict([START, at('digest: transcript is 9 bytes, reading its last 5'), ''].join('\n'), ID)).toMatchObject({ done: false, captured: false });
    expect(wrapperVerdict(`${wrote(ID)}\n`, ID)).toMatchObject({ done: false, captured: false });
    expect(wrapperVerdict('', ID)).toEqual({ done: false, captured: false, end: null });
  });

  it('gives null after the bound when no log shows up, and says so once', async () => {
    const said: string[] = [];
    const run = { s: { id: 'seqX' }, arm: 'X2', seed: 1, dirs: { home: tmp('z0-wrapwait-') } };
    const got = await wrapperWait({ codexWrapperWaitMs: 300, log: (m: string) => said.push(m) }, run, 'a-xa', ID);
    expect(got.captured).toBeNull();
    expect(got.wait).toMatchObject({ timedOut: true, end: null });
    expect(got.wait.ms).toBeGreaterThanOrEqual(300);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/seqX a-xa X2 seed1.*300 ms/);
  });

  it('takes the bound from --codex-wrapper-wait-ms, 120 s unless set, and refuses a value that is not a whole number', () => {
    expect([parseWrapperWait(), parseWrapperWait('500'), parseWrapperWait('0')]).toEqual([120_000, 500, 0]);
    for (const bad of ['-1', '1.5', 'soon', '']) expect(() => parseWrapperWait(bad), bad).toThrow(/--codex-wrapper-wait-ms/);
  });
});

describe('a file that is gone when the token sweep reads it', () => {
  it('reads a missing path as null and still throws on a folder', () => {
    const dir = tmp('z0-gone-');
    expect(readIfPresent(join(dir, 'hippo.db-shm'))).toBeNull();
    expect(() => readIfPresent(dir)).toThrow(/EISDIR/);
  });
});
