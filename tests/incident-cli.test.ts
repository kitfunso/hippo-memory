// tests/incident-cli.test.ts
//
// Regression coverage for `hippo incident` CLI argument handling. The E2-incident
// episode (2026-05-29) shipped a bug where `hippo incident open "<text>"` recorded
// the literal "open" keyword as the incident text and ignored the real text in
// args[1] — codex caught it at the review stage; both Claude review gates missed it.
// These tests lock the arg-shift so the documented `open` subcommand and the bare
// form both record the correct text. Uses the real-CLI subprocess harness
// (isolated cwd .hippo + HIPPO_HOME + HIPPO_SKIP_AUTO_INTEGRATIONS) like b3-goal-cli.
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
  const cwd = mkdtempSync(join(tmpdir(), 'hippo-incident-cli-'));
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
      HIPPO_SESSION_ID: 's-cli-inc',
      HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
    },
    encoding: 'utf8',
  });
}

describe('hippo incident CLI', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = makeEnv();
  });
  afterEach(() => {
    rmSync(env.cwd, { recursive: true, force: true });
  });

  it('`incident open "<text>"` records the real text, not the "open" keyword (codex P2 regression)', () => {
    const created = run(env, ['incident', 'open', 'DB down at 14:00']);
    expect(created).toMatch(/Incident recorded: #\d+/);
    const list = run(env, ['incident', 'list']);
    expect(list).toContain('DB down at 14:00');
  });

  it('bare `incident "<text>"` records the text', () => {
    run(env, ['incident', 'bare form incident']);
    const list = run(env, ['incident', 'list']);
    expect(list).toContain('bare form incident');
  });

  it('open -> resolve -> close lifecycle via CLI', () => {
    const open = run(env, ['incident', 'open', 'disk full on host-3']);
    const id = open.match(/#(\d+)/)?.[1];
    expect(id).toBeTruthy();
    run(env, ['incident', 'resolve', id as string, '--resolution', 'freed 20GB, rotated logs']);
    const resolved = run(env, ['incident', 'list', '--status', 'resolved']);
    expect(resolved).toContain('disk full on host-3');
    run(env, ['incident', 'close', id as string]);
    const closed = run(env, ['incident', 'list', '--status', 'closed']);
    expect(closed).toContain('disk full on host-3');
  });

  it('rejects a malformed id and does NOT mutate the wrong row (codex P2 regression)', () => {
    run(env, ['incident', 'open', 'still open incident']); // becomes #1
    // `close 1abc` must be REJECTED (non-zero exit) - parseInt("1abc")===1 would
    // otherwise silently close #1. execFileSync throws on a non-zero exit code.
    expect(() => run(env, ['incident', 'close', '1abc'])).toThrow();
    // #1 must still be open.
    const stillOpen = run(env, ['incident', 'list', '--status', 'open']);
    expect(stillOpen).toContain('still open incident');
  });
});
