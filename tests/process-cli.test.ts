// tests/process-cli.test.ts
//
// Regression coverage for `hippo process` CLI argument handling. The E2-incident
// episode (2026-05-29) shipped (and codex caught) two CLI bugs that both Claude
// review gates missed: (1) a create subcommand keyword stored as the entity text;
// (2) a lenient parseInt on a mutating subcommand hitting the wrong row. These
// tests lock both for `process` pre-emptively, plus the version chain. Uses the
// real-CLI subprocess harness (isolated cwd .hippo + HIPPO_HOME +
// HIPPO_SKIP_AUTO_INTEGRATIONS) like incident-cli / b3-goal-cli.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');

interface TestEnv {
  cwd: string;
  hippoRoot: string;
  globalRoot: string;
}

function makeEnv(): TestEnv {
  const cwd = mkdtempSync(join(tmpdir(), 'hippo-process-cli-'));
  const hippoRoot = join(cwd, '.hippo');
  const globalRoot = join(cwd, 'global-hippo');
  mkdirSync(globalRoot, { recursive: true });
  initStore(hippoRoot);
  return { cwd, hippoRoot, globalRoot };
}

function run(env: TestEnv, args: string[]): string {
  return execFileSync('node', [CLI, ...args], {
    cwd: env.cwd,
    env: {
      ...process.env,
      HIPPO_HOME: env.globalRoot,
      HIPPO_TENANT: 'default',
      HIPPO_SESSION_ID: 's-cli-proc',
      HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
    },
    encoding: 'utf8',
  });
}

describe('hippo process CLI', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = makeEnv();
  });
  afterEach(() => {
    rmSync(env.cwd, { recursive: true, force: true });
  });

  it('`process new "<name>" --step ...` records the real name + steps, not the "new" keyword (codex P2 regression)', () => {
    const created = run(env, ['process', 'new', 'Release flow', '--step', 'run tests', '--step', 'publish']);
    expect(created).toMatch(/Process recorded: #\d+/);
    const list = run(env, ['process', 'list']);
    expect(list).toContain('Release flow');
    // The keyword "new" must NOT have been stored as the process name.
    expect(list).not.toMatch(/^\s+new$/m);
    const id = created.match(/#(\d+)/)?.[1];
    const get = run(env, ['process', 'get', id as string]);
    expect(get).toContain('1. run tests');
    expect(get).toContain('2. publish');
  });

  it('bare `process "<name>"` records the name', () => {
    run(env, ['process', 'bare form process', '--step', 'only step']);
    const list = run(env, ['process', 'list']);
    expect(list).toContain('bare form process');
  });

  it('new -> supersede -> list version chain via CLI', () => {
    const open = run(env, ['process', 'new', 'Deploy', '--step', 'a']);
    const id = open.match(/#(\d+)/)?.[1];
    expect(id).toBeTruthy();
    const sup = run(env, ['process', 'supersede', id as string, '--step', 'a', '--step', 'b', '--change', 'added b']);
    expect(sup).toMatch(/v2/);
    // The active list now shows v2; the superseded original is excluded.
    const active = run(env, ['process', 'list', '--status', 'active']);
    expect(active).toContain('v2');
    const superseded = run(env, ['process', 'list', '--status', 'superseded']);
    expect(superseded).toContain('Deploy');
  });

  it('rejects a malformed id and does NOT mutate the wrong row (codex P2 regression)', () => {
    run(env, ['process', 'new', 'still active process', '--step', 'a']); // becomes #1
    // `close 1abc` must be REJECTED (non-zero exit) - parseInt("1abc")===1 would
    // otherwise silently close #1. execFileSync throws on a non-zero exit code.
    expect(() => run(env, ['process', 'close', '1abc'])).toThrow();
    expect(() => run(env, ['process', 'supersede', '1abc', '--step', 'x'])).toThrow();
    // #1 must still be active.
    const stillActive = run(env, ['process', 'list', '--status', 'active']);
    expect(stillActive).toContain('still active process');
  });
});
