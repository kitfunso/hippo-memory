// tests/customer-note-cli.test.ts
//
// Regression coverage for `hippo note` CLI handling, mirroring the codex P2 classes:
// create-keyword-as-data (the `new` keyword must not be recorded as the customer) +
// lenient parseInt on a mutating subcommand. Plus many-per-customer + version chain.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');

interface TestEnv { cwd: string; hippoRoot: string; globalRoot: string; }

function makeEnv(): TestEnv {
  const cwd = mkdtempSync(join(tmpdir(), 'hippo-note-cli-'));
  const hippoRoot = join(cwd, '.hippo');
  const globalRoot = join(cwd, 'global-hippo');
  mkdirSync(globalRoot, { recursive: true });
  initStore(hippoRoot);
  return { cwd, hippoRoot, globalRoot };
}
function run(env: TestEnv, args: string[]): string {
  return execFileSync('node', [CLI, ...args], {
    cwd: env.cwd,
    env: { ...process.env, HIPPO_HOME: env.globalRoot, HIPPO_TENANT: 'default', HIPPO_SESSION_ID: 's-cli-note', HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
    encoding: 'utf8',
  });
}

describe('hippo note CLI', () => {
  let env: TestEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { rmSync(env.cwd, { recursive: true, force: true }); });

  it('`note new "<customer>" --text ...` records the real customer, not the "new" keyword', () => {
    const created = run(env, ['note', 'new', 'Acme Corp', '--text', 'renewal call notes']);
    expect(created).toMatch(/Customer note recorded: #\d+/);
    const list = run(env, ['note', 'list']);
    expect(list).toContain('customer="Acme Corp"');
    expect(list).not.toContain('customer="new"');
    const id = created.match(/#(\d+)/)?.[1];
    const get = run(env, ['note', 'get', id as string]);
    expect(get).toContain('renewal call notes');
    expect(get).toContain('customer: Acme Corp');
  });

  it('bare `note "<customer>" --text` records the customer', () => {
    run(env, ['note', 'bare-customer', '--text', 'a note']);
    expect(run(env, ['note', 'list'])).toContain('customer="bare-customer"');
  });

  it('many notes per customer + new->supersede version chain', () => {
    run(env, ['note', 'new', 'Acme', '--text', 'note one']);
    const open = run(env, ['note', 'new', 'Acme', '--text', 'note two']);
    const id = open.match(/#(\d+)/)?.[1];
    // both active for the same customer (printNoteRow shows customer=, not the body)
    const active = run(env, ['note', 'list', '--customer', 'Acme', '--status', 'active']);
    expect((active.match(/customer="Acme"/g) ?? []).length).toBe(2);
    // supersede one
    const sup = run(env, ['note', 'supersede', id as string, '--text', 'note two v2', '--change', 'corrected']);
    expect(sup).toMatch(/v2/);
  });

  it('rejects a malformed id and does NOT mutate the wrong row (codex P2 regression)', () => {
    run(env, ['note', 'new', 'still-active', '--text', 'x']); // becomes #1
    expect(() => run(env, ['note', 'close', '1abc'])).toThrow();
    expect(() => run(env, ['note', 'supersede', '1abc', '--text', 'y'])).toThrow();
    expect(run(env, ['note', 'list', '--status', 'active'])).toContain('still-active');
  });
});
