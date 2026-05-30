// tests/policy-cli.test.ts
//
// Regression coverage for `hippo policy` CLI argument handling, mirroring the
// codex P2 classes locked for incident/process: (1) a create subcommand keyword
// stored as the entity name; (2) lenient parseInt on a mutating subcommand. Plus
// the bi-temporal as-of path and version chain. Real-CLI subprocess harness.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');

interface TestEnv { cwd: string; hippoRoot: string; globalRoot: string; }

function makeEnv(): TestEnv {
  const cwd = mkdtempSync(join(tmpdir(), 'hippo-policy-cli-'));
  const hippoRoot = join(cwd, '.hippo');
  const globalRoot = join(cwd, 'global-hippo');
  mkdirSync(globalRoot, { recursive: true });
  initStore(hippoRoot);
  return { cwd, hippoRoot, globalRoot };
}
function run(env: TestEnv, args: string[]): string {
  return execFileSync('node', [CLI, ...args], {
    cwd: env.cwd,
    env: { ...process.env, HIPPO_HOME: env.globalRoot, HIPPO_TENANT: 'default', HIPPO_SESSION_ID: 's-cli-pol', HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
    encoding: 'utf8',
  });
}

describe('hippo policy CLI', () => {
  let env: TestEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { rmSync(env.cwd, { recursive: true, force: true }); });

  it('`policy new "<name>" --text ...` records the real name, not the "new" keyword', () => {
    const created = run(env, ['policy', 'new', 'Retention policy', '--text', 'delete after 90d', '--from', '2026-01-01']);
    expect(created).toMatch(/Policy recorded: #\d+/);
    const list = run(env, ['policy', 'list']);
    expect(list).toContain('Retention policy');
    const id = created.match(/#(\d+)/)?.[1];
    const get = run(env, ['policy', 'get', id as string]);
    expect(get).toContain('delete after 90d');
    expect(get).toContain('valid_from: 2026-01-01T00:00:00.000Z');
  });

  it('bare `policy "<name>" --text` records the name', () => {
    run(env, ['policy', 'bare policy', '--text', 'a rule']);
    expect(run(env, ['policy', 'list'])).toContain('bare policy');
  });

  it('new -> supersede version chain + asof query via CLI', () => {
    const open = run(env, ['policy', 'new', 'Window', '--text', 'v1', '--from', '2026-01-01', '--to', '2026-06-01']);
    const id = open.match(/#(\d+)/)?.[1];
    const sup = run(env, ['policy', 'supersede', id as string, '--text', 'v2', '--from', '2026-01-01', '--to', '2026-06-01', '--change', 'reworded']);
    expect(sup).toMatch(/v2/);
    // as-of mid-window returns the active v2
    const asof = run(env, ['policy', 'asof', '2026-03-01', '--name', 'Window']);
    expect(asof).toContain('Window');
    expect(asof).toContain('v2');
    // as-of at the half-open end is not in force
    const atEnd = run(env, ['policy', 'asof', '2026-06-01', '--name', 'Window']);
    expect(atEnd).toContain('No active policies in force');
  });

  it('rejects a malformed id and does NOT mutate the wrong row (codex P2 regression)', () => {
    run(env, ['policy', 'new', 'still active', '--text', 'x']); // becomes #1
    expect(() => run(env, ['policy', 'close', '1abc'])).toThrow();
    expect(() => run(env, ['policy', 'supersede', '1abc', '--text', 'y'])).toThrow();
    expect(run(env, ['policy', 'list', '--status', 'active'])).toContain('still active');
  });

  it('rejects an inverted valid_to', () => {
    expect(() => run(env, ['policy', 'new', 'Inv', '--text', 'x', '--from', '2026-06-01', '--to', '2026-01-01'])).toThrow();
  });
});
