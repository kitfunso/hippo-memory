// CD11 end to end through the built CLI: the arm row each hook call books, and the holdout's empty stdout.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { initStore, writeEntry, saveActiveTaskSnapshot } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { hashArm } from '../src/pilot-arm.js';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');
const HOOK_ARGS = ['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'];
const START_ARGS = ['context', '--auto', '--budget', '1500'];

const BASE_ENV: NodeJS.ProcessEnv = { ...process.env };
delete BASE_ENV.HIPPO_SESSION_ID;
delete BASE_ENV.CLAUDE_CODE_SESSION_ID;

interface Payload { session_id: string; prompt?: string; hook_event_name?: string; source?: string; agent_id?: string }
interface ArmRow { session_id: string; tenant_id: string; surface: string; event: string; items: number; tokens: number; block_hash: string }

let tmp: string;
let proj: string;
const store = (dir: string): string => path.join(dir, '.hippo');

interface Config { pinnedInject: { promptRecall: boolean }; pilot?: { holdoutRateBp: number } }

function setRate(rate: number | null, dir = store(proj)): void {
  const config: Config = { pinnedInject: { promptRecall: false } };
  if (rate !== null) config.pilot = { holdoutRateBp: rate };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
}

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...BASE_ENV, HIPPO_HOME: path.join(tmp, 'global'), ...extra };
}

function run(args: string[], payload: Payload | null, dir = proj, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [HIPPO_JS, ...args], {
    cwd: dir, env: env(extra), input: payload === null ? '' : JSON.stringify(payload), encoding: 'utf8',
  });
}

const prompt = (sessionId: string, extra: Partial<Payload> = {}): Payload => ({ session_id: sessionId, prompt: 'hi', hook_event_name: 'UserPromptSubmit', ...extra });

function ledger<T>(root: string, sql: string): T[] {
  const db = openHippoDb(root);
  try {
    // SAFETY: each caller's SELECT names the columns of T.
    return db.prepare(sql).all() as T[];
  } finally {
    closeHippoDb(db);
  }
}
const arms = (root = store(proj)): ArmRow[] =>
  ledger<ArmRow>(root, `SELECT session_id, tenant_id, surface, event, items, tokens, block_hash FROM token_ledger WHERE event = 'arm' ORDER BY id`);
const injects = (root = store(proj)): number =>
  ledger<{ n: number }>(root, `SELECT COUNT(*) AS n FROM token_ledger WHERE event = 'inject'`)[0].n;

/** A session id whose hash arm is `arm` at `rate`, so a rate-driven case never depends on luck. */
function sessionFor(arm: 'hippo' | 'holdout', rate: number): string {
  for (let i = 0; ; i++) if (hashArm(`s-${i}`, rate) === arm) return `s-${i}`;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-pilot-arm-'));
  proj = path.join(tmp, 'proj');
  fs.mkdirSync(store(proj), { recursive: true });
  initStore(store(proj));
  writeEntry(store(proj), { ...createMemory('PINNED: always check the rollback plan before deploy'), pinned: true });
  setRate(10000);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the per-prompt hook', () => {
  it('holdout: empty stdout, one holdout row at the stored rate, no inject rows', () => {
    const r = run(HOOK_ARGS, prompt('h1'));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(arms()).toEqual([{ session_id: 'h1', tenant_id: 'default', surface: 'pilot', event: 'arm', items: 10000, tokens: 0, block_hash: 'holdout' }]);
    expect(injects()).toBe(0);
  });

  it('SessionStart payload on `hippo context --auto --budget 1500` books the arm without --pinned-only', () => {
    const r = run(START_ARGS, { session_id: 'ss1', hook_event_name: 'SessionStart', source: 'startup' });
    expect(r.stdout).toBe('');
    expect(arms().map((a) => [a.session_id, a.block_hash])).toEqual([['ss1', 'holdout']]);
  });

  it('books the arm before the --budget 0 early return', () => {
    run([...HOOK_ARGS, '--budget', '0'], prompt('b0'));
    expect(arms()).toHaveLength(1);
  });

  it('hippo arm on an EMPTY store still books a row, so an empty injection is not a selection filter', () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(store(empty), { recursive: true });
    initStore(store(empty));
    const id = sessionFor('hippo', 5000);
    setRate(5000, store(empty));
    const r = run(HOOK_ARGS, prompt(id), empty);
    expect(r.stdout).toBe('');
    expect(arms(store(empty)).map((a) => [a.block_hash, a.items])).toEqual([['hippo', 5000]]);
  });

  it('hippo arm prints exactly what rate 0 prints', () => {
    const id = sessionFor('hippo', 5000);
    const off = path.join(tmp, 'off', 'proj');
    fs.cpSync(proj, off, { recursive: true });
    setRate(0, store(off));
    setRate(5000);
    const expected = run(HOOK_ARGS, prompt(id), off).stdout;
    expect(expected).toContain('rollback plan');
    expect(run(HOOK_ARGS, prompt(id)).stdout).toBe(expected);
    expect(arms().map((a) => a.block_hash)).toEqual(['hippo']);
  });

  it('keeps one row across prompts of one session', () => {
    run(HOOK_ARGS, prompt('twice'));
    run(HOOK_ARGS, prompt('twice'));
    expect(arms()).toHaveLength(1);
  });

  it('rate 0 and a missing config: no row, normal output', () => {
    setRate(0);
    expect(run(HOOK_ARGS, prompt('z0')).stdout).toContain('rollback plan');
    setRate(null);
    run(HOOK_ARGS, prompt('z1'));
    expect(arms()).toHaveLength(0);
  });

  it('no session id: no row, normal output', () => {
    const r = run(HOOK_ARGS, null);
    expect(r.stdout).toContain('rollback plan');
    expect(arms()).toHaveLength(0);
  });

  it('sub-agent payload books nothing and follows the parent holdout', () => {
    run(HOOK_ARGS, prompt('parent'));
    const sub = run(HOOK_ARGS, prompt('parent', { agent_id: 'a1' }));
    expect(sub.stdout).toBe('');
    expect(arms()).toHaveLength(1);
    const fresh = run(HOOK_ARGS, prompt('lonely', { agent_id: 'a2' }));
    expect(fresh.stdout).toBe('');
    expect(arms().map((a) => a.session_id)).toEqual(['parent']);
  });

  it('env-only session id (the agent ran hippo context itself) follows a stored holdout and writes nothing', () => {
    run(HOOK_ARGS, prompt('envs'));
    const r = run(['context', '--auto'], null, proj, { CLAUDE_CODE_SESSION_ID: 'envs' });
    expect(r.stdout).toBe('');
    expect(arms()).toHaveLength(1);
    const unknown = run(['context', '--auto'], null, proj, { CLAUDE_CODE_SESSION_ID: 'never-seen' });
    expect(unknown.stdout).toBe('');
    expect(arms()).toHaveLength(1);
  });

  it('a stored row wins over a later rate change', () => {
    run(HOOK_ARGS, prompt('keep'));
    setRate(0);
    expect(run(HOOK_ARGS, prompt('keep')).stdout).toContain('rollback plan');
    setRate(10000);
    expect(run(HOOK_ARGS, prompt('keep')).stdout).toBe('');
    expect(arms()).toHaveLength(1);
  });

  it('two concurrent processes on a fresh session: one row, both print nothing', async () => {
    const child = () => new Promise<{ code: number | null; out: string }>((resolve) => {
      const c = spawn(process.execPath, [HIPPO_JS, ...HOOK_ARGS], { cwd: proj, env: env() });
      let out = '';
      c.stdout.on('data', (d) => { out += String(d); });
      c.on('close', (code) => resolve({ code, out }));
      c.stdin.end(JSON.stringify(prompt('race')));
    });
    const results = await Promise.all([child(), child()]);
    expect(results.map((r) => [r.code, r.out])).toEqual([[0, ''], [0, '']]);
    expect(arms()).toHaveLength(1);
  });

  it('with no local store the row lands in the global store and compact-resume finds it there', () => {
    const bare = path.join(tmp, 'bare');
    fs.mkdirSync(bare, { recursive: true });
    const globalRoot = path.join(tmp, 'global');
    fs.mkdirSync(globalRoot, { recursive: true });
    initStore(globalRoot);
    setRate(10000, globalRoot);
    saveActiveTaskSnapshot(globalRoot, 'default', { task: 'ship', summary: 'half done', next_step: 'run tests', session_id: 'gs1' });
    run(HOOK_ARGS, prompt('gs1'), bare);
    expect(arms(globalRoot).map((a) => a.block_hash)).toEqual(['holdout']);
    expect(run(['compact-resume'], { session_id: 'gs1', source: 'compact' }, bare).stdout).toBe('');
  });
});

describe('compact-resume', () => {
  const snapshot = (sessionId: string): void => {
    saveActiveTaskSnapshot(store(proj), 'default', { task: 'ship', summary: 'half done', next_step: 'run tests', session_id: sessionId });
  };

  it('prints nothing for a holdout session with a fresh snapshot and books no row', () => {
    snapshot('cr1');
    run(HOOK_ARGS, prompt('cr1'));
    const r = run(['compact-resume'], { session_id: 'cr1', source: 'compact' });
    expect(r.stdout).toBe('');
    expect(arms()).toHaveLength(1);
  });

  it('prints as before for the hippo arm', () => {
    const id = sessionFor('hippo', 5000);
    setRate(5000);
    snapshot(id);
    run(HOOK_ARGS, prompt(id));
    expect(run(['compact-resume'], { session_id: id, source: 'compact' }).stdout).toContain('Restored after compaction');
  });

  it('prints as before at rate 0', () => {
    setRate(0);
    snapshot('cr0');
    expect(run(['compact-resume'], { session_id: 'cr0', source: 'compact' }).stdout).toContain('Restored after compaction');
  });
});
