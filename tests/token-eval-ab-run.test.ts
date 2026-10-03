// Z0 runner end to end with a stand-in for Claude Code (tests/fixtures/fake-claude.mjs), so it costs nothing.
// Real git, hidden-test grading, hippo hooks, ledger and CLI; the stand-in's token numbers are made up.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { runAll, planRuns, validateTasks, usageFromResult, isUsageLimit, prependPath, transcriptWork } from '../scripts/token-eval/ab-run.mjs';
import { ARM_SEEDS } from '../scripts/token-eval/arms.mjs';
import { parseRuns, analyze } from '../scripts/token-eval/ab-analyze.mjs';
import { loadAllEntries } from '../src/store.js';

const FAKE = resolve(__dirname, 'fixtures', 'fake-claude.mjs');
const CLAUDE = `"${process.execPath}" "${FAKE}"`;
const dirs: string[] = [];
const envKeys = ['HOME', 'USERPROFILE', 'APPDATA', 'PATH', 'Path', 'CLAUDE_CODE_OAUTH_TOKEN', 'FAKE_CLAUDE_LIMIT_ONCE'];
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

const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

/** Temp operator HOME, USERPROFILE, APPDATA and cwd, so nothing reaches the real ones. */
function isolate(): string {
  const home = tmp('ab-run-home-');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
  process.chdir(tmp('ab-run-cwd-'));
  return home;
}

interface FixtureRepo { repo: string; base: string; fix: string }

function makeRepo(): FixtureRepo {
  const repo = tmp('ab-run-repo-');
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
  writeFileSync(join(repo, 'test.js'), "const { add } = require('./lib.js');\nif (add(2, 3) !== 5) { console.error('add is wrong'); process.exit(1); }\n");
  git('add', '.');
  git('commit', '-qm', 'fix add and test it');
  return { repo, base, fix: git('rev-parse', 'HEAD') };
}

const PAD = 'pad one\npad two\npad three\npad four\n';
const STUB = '# Instructions for coding agents working in this repository.\n';

/** Two bases whose native AGENTS.md and docs/AGENTS.md differ, on an eol-filtered repo, then the fix. */
function makeCarryRepo(): FixtureRepo & { base2: string } {
  const r = makeRepo();
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: r.repo, encoding: 'utf8' }).trim();
  git('checkout', '-q', '-b', 'carry', r.base);
  mkdirSync(join(r.repo, 'docs'));
  const commit = (top: string, docs: string, msg: string) => {
    writeFileSync(join(r.repo, 'AGENTS.md'), `${top}\n${PAD}`);
    writeFileSync(join(r.repo, 'docs', 'AGENTS.md'), docs);
    writeFileSync(join(r.repo, 'CLAUDE.md'), 'native claude file\n');
    writeFileSync(join(r.repo, '.gitattributes'), '* text=auto\n');
    writeFileSync(join(r.repo, '.gitignore'), 'CLAUDE.local.md\n.scratch/\n');
    git('add', '.');
    git('commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  const base = commit('native v1 top', 'docs v1\n', 'base one');
  const base2 = commit('native v2 top', 'docs v2\n', 'base two');
  git('cherry-pick', '-n', r.fix);
  git('commit', '-qm', 'fix');
  return { repo: r.repo, base, base2, fix: git('rev-parse', 'HEAD') };
}

const task = (r: FixtureRepo, id: string, prompt: string, extra: Record<string, string> = {}) => ({ id, baseRef: r.base, fixRef: r.fix, prompt, testFiles: ['test.js'], test: 'node test.js', ...extra });
const readRecords = (out: string) => readFileSync(join(out, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const rawResult = (out: string, seq: string, arm: string, id: string) => JSON.parse(readFileSync(join(out, 'raw', seq, arm, 'seed1', `${id}.json`), 'utf8'));

/** A dir on the parent PATH with a working `hippo` that leaves a marker when run. */
function decoyHippo() {
  const dir = tmp('ab-run-decoy-');
  const marker = join(dir, 'ran');
  writeFileSync(join(dir, 'hippo'), `#!/bin/sh\necho decoy > "${marker}"\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'hippo.cmd'), `@echo decoy> "${marker}"\r\n`);
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  process.env[key] = `${dir}${delimiter}${process.env[key]}`;
  return { dir, marker };
}

type RunOpts = Parameters<typeof runAll>[0];

async function run(spec: RunOpts['spec'], arms: string[], out: string, extra: Partial<RunOpts> = {}) {
  return runAll({ spec, arms, seeds: 1, outDir: out, model: null, claudeBin: CLAUDE, settleMs: 0, warmup: false, log: () => {}, ...extra });
}

describe('Z0 runner plan and reads', () => {
  it('validates task files', () => {
    expect(() => validateTasks({ sequences: [] })).toThrow(/non-empty/);
    expect(() => validateTasks({ sequences: [{ id: 's', cluster: 'c', repo: 'r', tasks: [{ id: 't' }] }] })).toThrow(/at least 2 tasks/);
  });

  it('plans lockstep steps, position-major, rotating the arm order over the active arms', () => {
    const t = { id: 't' };
    const spec = { sequences: [{ id: 's1', tasks: [t, t, t] }, { id: 's2', tasks: [t, t] }] };
    const steps = planRuns(spec, ['A0', 'A1', 'A2', 'A5']);
    const keys = steps.map((s: { sequence: { id: string }; arm: string; seed: number; position: number }) => `${s.sequence.id}|${s.arm}|${s.seed}|${s.position}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe((3 + 2) * (ARM_SEEDS.A0 + ARM_SEEDS.A1 + ARM_SEEDS.A2 + ARM_SEEDS.A5));
    for (let i = 1; i < steps.length; i++) {
      const [a, b] = [steps[i - 1], steps[i]];
      expect(a.seed < b.seed || (a.seed === b.seed && a.position <= b.position)).toBe(true);
    }
    const firsts = (seed: number) => [0, 1, 2].map((p) => steps.find((s: { seed: number; position: number }) => s.seed === seed && s.position === p).arm);
    expect(steps.filter((s: { seed: number; arm: string }) => s.seed === 3 && s.arm === 'A0')).toHaveLength(0);
    expect(new Set(firsts(3))).toEqual(new Set(['A1', 'A2', 'A5']));
    expect(firsts(1)[0]).not.toBe(firsts(1)[1]);
    const fours = planRuns(spec, ['A0', 'A1'], () => 4);
    expect(new Set(fours.filter((s: { arm: string }) => s.arm === 'A0').map((s: { seed: number }) => s.seed))).toEqual(new Set([1, 2, 3, 4]));
  });

  it('reads usage from modelUsage, not the top-level usage that can read zero', () => {
    const u = usageFromResult({
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      modelUsage: { a: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 }, b: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1 } },
    });
    expect(u).toEqual({ inputTokens: 11, cacheWriteTokens: 21, cacheReadTokens: 101, outputTokens: 6 });
  });

  it('counts Read, Grep and shell read commands as file reads, at most one per call', () => {
    const cases: Array<[string, Record<string, string>, boolean]> = [
      ['Read', {}, true], ['Grep', {}, true], ['Edit', {}, false],
      ['Bash', { command: 'cat a.txt' }, true], ['Bash', { command: 'git log | head -5' }, true],
      ['Bash', { command: 'npm test && grep -n x a.ts' }, true], ['Bash', { command: '(rg foo; ls)' }, true],
      ['Bash', { command: 'sed -n 1,5p a' }, true], ['Bash', { command: 'sed -i s/a/b/ a' }, false],
      ['Bash', { command: 'ls -la' }, false], ['Bash', { command: 'echo cat' }, false], ['Bash', { command: 'type x' }, false],
      ['Bash', { command: 'tail -f log || less x' }, true], ['Bash', { command: 'catalog x' }, false],
      ['PowerShell', { command: 'type x' }, true], ['PowerShell', { command: 'Get-Content a.txt | Select-String b' }, true],
      ['PowerShell', { command: 'gc a' }, true], ['PowerShell', { command: 'Get-ChildItem' }, false],
    ];
    const dir = tmp('ab-run-reads-');
    const file = join(dir, 't.jsonl');
    writeFileSync(file, cases.map(([name, input], i) => JSON.stringify({ message: { content: [{ type: 'tool_use', id: `t${i}`, name, input }] } })).join('\n'));
    const work = transcriptWork(file, new Set());
    const shells = cases.filter(([n, , counted]) => counted && n !== 'Read' && n !== 'Grep').length;
    expect(work).toMatchObject({ toolCalls: cases.length, fileReads: cases.filter(([, , c]) => c).length, shellReads: shells });
  });

  it('prepends to PATH under the key the env already uses, never a second one', () => {
    const win = prependPath({ Path: 'C:\\Windows' }, 'bin');
    expect(Object.keys(win)).toEqual(['Path']);
    expect(win.Path).toBe(`bin${delimiter}C:\\Windows`);
    expect(prependPath({ PATH: '/usr/bin' }, 'bin')).toEqual({ PATH: `bin${delimiter}/usr/bin` });
    expect(prependPath({}, 'bin')).toEqual({ PATH: `bin${delimiter}` });
  });

  it('treats a usage limit or overload as a rerun, never a budget cap or a normal result', () => {
    expect(isUsageLimit({ is_error: true, subtype: 'success', result: 'Claude AI usage limit reached|1790000000' }, 'Claude AI usage limit reached|1790000000')).toBe(true);
    expect(isUsageLimit(null, 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}')).toBe(true);
    expect(isUsageLimit(null, "You've hit your limit")).toBe(true);
    expect(isUsageLimit({ is_error: false, result: 'the rate limit reached its cap' }, 'the rate limit reached its cap')).toBe(false);
    expect(isUsageLimit({ is_error: true, subtype: 'error_max_budget_usd' }, 'budget limit reached')).toBe(false);
    expect(isUsageLimit({ is_error: true, subtype: 'error_during_execution' }, 'TypeError: x is undefined')).toBe(false);
  });
});

describe('Z0 runner end to end (fake Claude Code)', () => {
  it('runs all four arms with their settings, env, homes and PATH, and keeps the token out of every file', async () => {
    const home = isolate();
    const decoy = decoyHippo();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sentinel-z0-token';
    const r = makeRepo();
    const out = tmp('ab-run-out-');
    const spec = validateTasks({ sequences: [{ id: 'seqA', cluster: 'repoA', repo: r.repo, tasks: [task(r, 'a1', 'FIX add in lib.js'), task(r, 'a2', 'look around only')] }] });
    await run(spec, ['A0', 'A1', 'A2', 'A5'], out);

    const records = readRecords(out);
    expect(records).toHaveLength(8);
    const get = (arm: string, id: string) => records.find((x) => x.arm === arm && x.taskId === id);
    const raw = (arm: string, id: string) => rawResult(out, 'seqA', arm, id);
    for (const arm of ['A0', 'A1', 'A2', 'A5']) {
      const dirsOf = join(out, 'runs', 'seqA', arm, 'seed1');
      const res = raw(arm, 'a1');
      expect(res.env).toMatchObject({
        CLAUDE_CONFIG_DIR: join(dirsOf, 'claude-config'), CODEX_HOME: join(dirsOf, 'codex-home'), HIPPO_HOME: join(dirsOf, 'hippo-home'),
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: arm === 'A0' ? '1' : '0', HIPPO_AGENT_MEMORY_TOOLS: 'claude-code,codex', DISABLE_AUTOUPDATER: '1', EVAL_SEED: '1',
      });
      expect(res.hasToken).toBe(true);
      expect(res.argv).toEqual(expect.arrayContaining(['--setting-sources', 'project', '--strict-mcp-config']));
      expect(get(arm, 'a1')).toMatchObject({ resolved: true, transcriptFound: true, fileReads: 2, shellReads: 1 });
      expect(get(arm, 'a1').envKeys).toEqual(expect.arrayContaining(['CLAUDE_CONFIG_DIR', 'HIPPO_HOME']));
      expect(get(arm, 'a1').envKeys.some((k: string) => /^ANTHROPIC_/i.test(k))).toBe(false);
      expect(get(arm, 'a1').order).toEqual(expect.any(Number));
      expect([get(arm, 'a1').position, get(arm, 'a2').position]).toEqual([0, 1]);
      const settings = JSON.parse(readFileSync(join(out, 'settings', `seqA-${arm}-seed1.json`), 'utf8'));
      if (arm === 'A0') expect(settings).toEqual({ autoMemoryEnabled: false });
      if (arm === 'A1') expect(settings).toEqual({});
      if (arm === 'A2') expect(Object.keys(settings.hooks)).toContain('SessionEnd');
      if (arm === 'A5') expect(Object.keys(settings.hooks).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
      if (arm === 'A0' || arm === 'A1') {
        expect(res.hippoProbe.status).not.toBe(0);
        expect(res.hippoProbe.stderr).toMatch(/not recognized|not found/i);
        expect(res.hippoDir).toBeNull();
      } else {
        expect(res.hippoProbe.status).toBe(0);
        expect(res.hippoProbe.stdout).toMatch(/\d+\.\d+\.\d+/);
        expect(res.hippoDir).toBe(join(dirsOf, 'bin'));
      }
    }
    expect(existsSync(decoy.marker)).toBe(false);
    expect(get('A1', 'a2').repeatedErrors).toBe(1);

    // A2 captures the FIX lesson through its shim and injects it on a2; A5's shim drops it.
    const store = (arm: string) => loadAllEntries(join(out, 'runs', 'seqA', arm, 'seed1', 'work', '.hippo'));
    const lesson = (arm: string) => store(arm).some((e: { content: string }) => e.content.includes('operator flipped'));
    expect(lesson('A2')).toBe(true);
    expect(lesson('A5')).toBe(false);
    expect(store('A2').length).toBeGreaterThan(store('A5').length);
    expect(get('A2', 'a2').hippo.sent).toBeGreaterThan(0);
    expect(get('A0', 'a2').hippo).toBeNull();

    // No future: the workspace history ends at the task's base, never the fix.
    const log = execFileSync('git', ['log', '--all', '--format=%H'], { cwd: join(out, 'runs', 'seqA', 'A2', 'seed1', 'work'), encoding: 'utf8' });
    expect(log).toContain(r.base);
    expect(log).not.toContain(r.fix);

    const textUnder = (dir: string): string => (existsSync(dir) ? readdirSync(dir).map((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? textUnder(p) : readFileSync(p, 'latin1');
    }).join('\n') : '');
    for (const where of ['runs.jsonl', 'raw', 'settings', ...['A0', 'A1', 'A2', 'A5'].map((a) => join('runs', 'seqA', a, 'seed1', 'claude-config', 'projects'))]) {
      const p = join(out, where);
      expect(statSync(p).isDirectory() ? textUnder(p) : readFileSync(p, 'utf8')).not.toContain('sentinel-z0-token');
    }
    expect(existsSync(join(home, '.claude'))).toBe(false);

    const result = analyze(parseRuns(readFileSync(join(out, 'runs.jsonl'), 'utf8')), { control: 'A0' });
    expect(result.comparisons.map((c: { arm: string }) => c.arm).sort()).toEqual(['A1', 'A2', 'A5']);
  }, 240_000);

  it('carries instruction files the agent wrote to the next task, merged onto the new base', async () => {
    isolate();
    const r = makeCarryRepo();
    const out = tmp('ab-run-carry-');
    const setup = `node -e "require('fs').writeFileSync('CLAUDE.local.md','from setup')"`;
    const spec = validateTasks({ sequences: [{ id: 'seqC', cluster: 'c', repo: r.repo, tasks: [
      task(r, 'c1', 'FIX CARRY', { setup }), task(r, 'c2', 'DELETE', { baseRef: r.base2 }), task(r, 'c3', 'look around only', { baseRef: r.base2 }),
    ] }] });
    await run(spec, ['A0', 'A1', 'A2', 'A5'], out);
    const records = readRecords(out);
    const seen = (arm: string, id: string): Record<string, string> => rawResult(out, 'seqC', arm, id).files;
    for (const id of ['c1', 'c2', 'c3']) expect(new Set(records.filter((x) => x.taskId === id).map((x) => x.baseCommit)).size).toBe(1);
    expect(seen('A0', 'c1')['CLAUDE.local.md']).toBe('from setup');
    expect(seen('A0', 'c2')).toEqual({ 'CLAUDE.md': STUB, 'AGENTS.md': `native v2 top\n${PAD}`, 'docs/AGENTS.md': 'docs v2\n' });
    for (const arm of ['A0', 'A1', 'A2', 'A5']) {
      const c2 = seen(arm, 'c2');
      expect(c2['docs/AGENTS.md'], arm).toBe('docs v2\n');
      for (const gone of ['CLAUDE.local.md', '.scratch/note.md', '.claude/agents/x.md']) expect(c2, `${arm} ${gone}`).not.toHaveProperty(gone);
      expect('AGENTS.md' in seen(arm, 'c3'), arm).toBe(arm === 'A0');
      if (arm === 'A0') continue;
      expect(c2).toMatchObject({ '.claude/rules/r.md': 'carried rule\n', 'sub/CLAUDE.md': 'carried sub\n' });
      expect(c2['CLAUDE.md']).toMatch(/^# Instructions for coding agents[^]*carried claude line/);
      expect(c2['AGENTS.md']).toMatch(/^native v2 top\n[^]*carried agents note\n/);
      expect(records.find((x) => x.arm === arm && x.taskId === 'c2').carryMerges).toBeGreaterThanOrEqual(1);
      if (arm === 'A1') continue;
      expect(c2['CLAUDE.md']).toContain('hippo:start');
      expect(c2['AGENTS.md']).toContain('hippo:start');
    }
  }, 240_000);

  it('a task with a failing setup is skipped, not graded as unresolved', async () => {
    isolate();
    const r = makeRepo();
    const out = tmp('ab-run-setup-fail-');
    const spec = validateTasks({ sequences: [{ id: 'seqE', cluster: 'repoE', repo: r.repo, tasks: [task(r, 'e1', 'look around only'), task(r, 'e2', 'FIX add in lib.js', { setup: 'exit 1' })] }] });
    await run(spec, ['A1'], out);
    const e2 = readRecords(out).find((x) => x.taskId === 'e2');
    expect(e2).toMatchObject({ invalid: 'setup', resolved: false });
    expect(existsSync(join(out, 'raw', 'seqE', 'A1', 'seed1', 'e2.json'))).toBe(false);
    expect(existsSync(join(out, 'raw', 'seqE', 'A1', 'seed1', 'e2.setup.txt'))).toBe(true);
  }, 60_000);

  it('a usage limit waits, resets the checkout and reruns the same session instead of recording a failure', async () => {
    isolate();
    const r = makeRepo();
    const out = tmp('ab-run-limit-');
    const spec = validateTasks({ sequences: [{ id: 'seqL', cluster: 'repoL', repo: r.repo, tasks: [task(r, 'l1', 'LIMIT FIX add in lib.js'), task(r, 'l2', 'look around only')] }] });
    process.env.FAKE_CLAUDE_LIMIT_ONCE = join(out, 'limit-hit');
    await run(spec, ['A0'], out, { limitWaitMs: 0 });
    const records = readRecords(out);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ taskId: 'l1', resolved: true, invalid: null, agentError: null, limitRetries: 1 });
    const raw = join(out, 'raw', 'seqL', 'A0', 'seed1');
    expect(existsSync(join(raw, 'l1.limit1.txt'))).toBe(true);
    expect(JSON.parse(readFileSync(join(raw, 'l1.json'), 'utf8')).strayFile).toBe(false);
  }, 60_000);

  it('a limit retry restores the pre-session instruction files: carried edits in A1, init block in A2 at position 0', async () => {
    isolate();
    const r = makeCarryRepo();
    const carried = tmp('ab-run-limit-carry-');
    process.env.FAKE_CLAUDE_LIMIT_ONCE = join(carried, 'limit-hit');
    const spec = (first: string, second: string) => validateTasks({ sequences: [{ id: 'seqL', cluster: 'c', repo: r.repo, tasks: [task(r, 'l1', first), task(r, 'l2', second, { baseRef: r.base2 })] }] });
    await run(spec('CARRY', 'LIMIT look around'), ['A1'], carried, { limitWaitMs: 0 });
    expect(readRecords(carried)[1]).toMatchObject({ taskId: 'l2', limitRetries: 1 });
    const agents = rawResult(carried, 'seqL', 'A1', 'l2').files['AGENTS.md'];
    expect(agents).toContain('carried agents note');
    expect(agents).not.toContain('limited edit');

    const first = tmp('ab-run-limit-init-');
    process.env.FAKE_CLAUDE_LIMIT_ONCE = join(first, 'limit-hit');
    await run(spec('LIMIT FIX', 'look around only'), ['A2'], first, { limitWaitMs: 0 });
    expect(readRecords(first)[0]).toMatchObject({ taskId: 'l1', limitRetries: 1 });
    const seen = rawResult(first, 'seqL', 'A2', 'l1').files;
    expect(seen['CLAUDE.md']).toContain('hippo:start');
    expect(seen['AGENTS.md']).not.toContain('limited edit');
  }, 120_000);

  it('hippo init and hooks never touch the operator home (settings, MEMORY.md import)', async () => {
    const realHome = isolate();
    const r = makeRepo();
    const out = tmp('ab-run-iso-');
    const sentinel = 'SENTINEL-ab-run-leak the answer is to flip the operator in add';
    const memDir = join(realHome, '.claude', 'projects', 'some-project', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'answer.md'), `---\nname: answer\ntype: project\n---\n${sentinel}\n`);
    const spec = validateTasks({ sequences: [{ id: 'seqI', cluster: 'repoI', repo: r.repo, tasks: [task(r, 'i1', 'FIX add in lib.js'), task(r, 'i2', 'look around only')] }] });
    await run(spec, ['A2'], out);
    expect(existsSync(join(realHome, '.claude', 'settings.json'))).toBe(false);
    const store = join(out, 'runs', 'seqI', 'A2', 'seed1', 'work', '.hippo');
    expect(existsSync(store)).toBe(true);
    expect(loadAllEntries(store).some((e: { content: string }) => e.content.includes('SENTINEL-ab-run-leak'))).toBe(false);
  }, 60_000);

  it('validates and plans a run with dist/ absent (no build needed to dry-run)', () => {
    const scratch = tmp('ab-run-nodist-');
    const scriptsDir = join(scratch, 'scripts', 'token-eval');
    mkdirSync(scriptsDir, { recursive: true });
    const src = resolve(__dirname, '..', 'scripts', 'token-eval');
    for (const f of readdirSync(src)) writeFileSync(join(scriptsDir, f), readFileSync(join(src, f)));
    const r = makeRepo();
    const tasksFile = join(scratch, 'tasks.json');
    writeFileSync(tasksFile, JSON.stringify(validateTasks({ sequences: [{ id: 'seqA', cluster: 'c', repo: r.repo, tasks: [task(r, 'a1', 'x'), task(r, 'a2', 'y')] }] })));
    expect(existsSync(join(scratch, 'dist'))).toBe(false);
    const cli = (extra: string[], env: Record<string, string>) => spawnSync(process.execPath, [join(scriptsDir, 'ab-run.mjs'), '--tasks', tasksFile, '--out', join(scratch, 'out'), ...extra], { encoding: 'utf8', env: { ...process.env, ...env } });
    const dry = cli(['--dry-run'], { Z0_ANCESTOR_STOP: scratch });
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('steps');
    expect(dry.stdout).toContain('seqA');
  });
});
