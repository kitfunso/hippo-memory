// tests/skill-cli.test.ts
//
// Regression coverage for `hippo skill` CLI handling, mirroring the codex P2
// classes locked for the other E2 objects: create-keyword-as-name + lenient
// parseInt on a mutating subcommand. Plus the export path + version chain.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');

interface TestEnv { cwd: string; hippoRoot: string; globalRoot: string; }

function makeEnv(): TestEnv {
  const cwd = mkdtempSync(join(tmpdir(), 'hippo-skill-cli-'));
  const hippoRoot = join(cwd, '.hippo');
  const globalRoot = join(cwd, 'global-hippo');
  mkdirSync(globalRoot, { recursive: true });
  initStore(hippoRoot);
  return { cwd, hippoRoot, globalRoot };
}
function run(env: TestEnv, args: string[]): string {
  return execFileSync('node', [CLI, ...args], {
    cwd: env.cwd,
    env: { ...process.env, HIPPO_HOME: env.globalRoot, HIPPO_TENANT: 'default', HIPPO_SESSION_ID: 's-cli-skill', HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
    encoding: 'utf8',
  });
}

describe('hippo skill CLI', () => {
  let env: TestEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { rmSync(env.cwd, { recursive: true, force: true }); });

  it('`skill new "<name>" --instructions ...` records the real name, not the "new" keyword', () => {
    const created = run(env, ['skill', 'new', 'Run tests', '--instructions', 'npm test', '--trigger', 'before commit']);
    expect(created).toMatch(/Skill recorded: #\d+/);
    const list = run(env, ['skill', 'list']);
    expect(list).toContain('Run tests');
    const id = created.match(/#(\d+)/)?.[1];
    const get = run(env, ['skill', 'get', id as string]);
    expect(get).toContain('npm test');
    expect(get).toContain('when: before commit');
  });

  it('bare `skill "<name>" --instructions` records the name', () => {
    run(env, ['skill', 'bare skill', '--instructions', 'do it']);
    expect(run(env, ['skill', 'list'])).toContain('bare skill');
  });

  it('new -> supersede version chain + export via CLI', () => {
    const open = run(env, ['skill', 'new', 'Lint', '--instructions', 'eslint v1']);
    const id = open.match(/#(\d+)/)?.[1];
    const sup = run(env, ['skill', 'supersede', id as string, '--instructions', 'eslint v2', '--change', 'updated']);
    expect(sup).toMatch(/v2/);
    // export renders the active v2 only
    const md = run(env, ['skill', 'export']);
    expect(md).toContain('## Lint');
    expect(md).toContain('eslint v2');
    expect(md).not.toContain('eslint v1');
  });

  it('export on an empty store prints a friendly message', () => {
    expect(run(env, ['skill', 'export'])).toContain('No active skills');
  });

  it('rejects a malformed id and does NOT mutate the wrong row (codex P2 regression)', () => {
    run(env, ['skill', 'new', 'still active', '--instructions', 'x']); // becomes #1
    expect(() => run(env, ['skill', 'close', '1abc'])).toThrow();
    expect(() => run(env, ['skill', 'supersede', '1abc', '--instructions', 'y'])).toThrow();
    expect(run(env, ['skill', 'list', '--status', 'active'])).toContain('still active');
  });
});
