// tests/project-brief-cli.test.ts
//
// Regression coverage for `hippo brief` CLI handling, mirroring the codex P2
// classes locked for the other E2 objects: create-keyword-as-repo (the `new`
// keyword must not be recorded as the repo) + lenient parseInt on a mutating
// subcommand. Plus the refresh path (write + dry-run) and the version chain.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');

interface TestEnv { cwd: string; hippoRoot: string; globalRoot: string; }

function makeEnv(): TestEnv {
  const cwd = mkdtempSync(join(tmpdir(), 'hippo-brief-cli-'));
  const hippoRoot = join(cwd, '.hippo');
  const globalRoot = join(cwd, 'global-hippo');
  mkdirSync(globalRoot, { recursive: true });
  initStore(hippoRoot);
  return { cwd, hippoRoot, globalRoot };
}
function run(env: TestEnv, args: string[]): string {
  return execFileSync('node', [CLI, ...args], {
    cwd: env.cwd,
    env: { ...process.env, HIPPO_HOME: env.globalRoot, HIPPO_TENANT: 'default', HIPPO_SESSION_ID: 's-cli-brief', HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
    encoding: 'utf8',
  });
}

describe('hippo brief CLI', () => {
  let env: TestEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { rmSync(env.cwd, { recursive: true, force: true }); });

  it('`brief new "<repo>" --summary ...` records the real repo, not the "new" keyword', () => {
    const created = run(env, ['brief', 'new', 'hippo', '--summary', 'agent memory lib']);
    expect(created).toMatch(/Project brief recorded: #\d+/);
    const list = run(env, ['brief', 'list']);
    expect(list).toContain('repo="hippo"');
    expect(list).not.toContain('repo="new"');
    const id = created.match(/#(\d+)/)?.[1];
    const get = run(env, ['brief', 'get', id as string]);
    expect(get).toContain('agent memory lib');
    expect(get).toContain('repo: hippo');
  });

  it('bare `brief "<repo>" --summary` records the repo', () => {
    run(env, ['brief', 'bare-repo', '--summary', 'do it']);
    expect(run(env, ['brief', 'list'])).toContain('repo="bare-repo"');
  });

  it('new -> supersede version chain', () => {
    const open = run(env, ['brief', 'new', 'r', '--summary', 'v1 body']);
    const id = open.match(/#(\d+)/)?.[1];
    const sup = run(env, ['brief', 'supersede', id as string, '--summary', 'v2 body', '--change', 'updated']);
    expect(sup).toMatch(/v2/);
    const active = run(env, ['brief', 'list', '--status', 'active', '--repo', 'r']);
    expect(active).toContain('v2');
  });

  it('refresh writes a v1 brief; --dry-run prints the digest without writing', () => {
    // dry-run prints a valid digest (zero receipts is fine) and writes nothing.
    // (Receipt path-tag matching is covered precisely in the store test; here we
    // only exercise the CLI write vs dry-run paths.)
    const dry = run(env, ['brief', 'refresh', 'demo-repo', '--dry-run']);
    expect(dry).toContain('# Project Brief: demo-repo');
    expect(run(env, ['brief', 'list'])).toContain('No project briefs.');
    // real refresh writes a v1
    const refreshed = run(env, ['brief', 'refresh', 'demo-repo']);
    expect(refreshed).toMatch(/Project brief #\d+ recorded \(v1\)/);
    expect(run(env, ['brief', 'list'])).toContain('repo="demo-repo"');
  });

  it('rejects a malformed id and does NOT mutate the wrong row (codex P2 regression)', () => {
    run(env, ['brief', 'new', 'still-active', '--summary', 'x']); // becomes #1
    expect(() => run(env, ['brief', 'close', '1abc'])).toThrow();
    expect(() => run(env, ['brief', 'supersede', '1abc', '--summary', 'y'])).toThrow();
    expect(run(env, ['brief', 'list', '--status', 'active'])).toContain('still-active');
  });
});
