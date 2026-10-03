// Z0 runner units: arm env and PATH, settings, per-run homes, workspace carry and the preflight checks.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { armEnv, childEnv, armSettings, cleanPath, assertToolsResolve, writeHippoShim, ARMS } from '../scripts/token-eval/arms.mjs';
import { HIPPO_JS } from '../scripts/token-eval/exec.mjs';
import { runDirs, freshRunDirs, assertFreshEmpty, ancestorInstructionFiles, parseImportDryRun, checkImportHomes, checkHomes } from '../scripts/token-eval/homes.mjs';
import { STUB_CLAUDE_MD, stubBaseCommit, isInstructionPath, instructionSnapshot, instructionDelta, applyInstructions, checkoutBase, goldLines } from '../scripts/token-eval/workspace.mjs';

const dirs: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const win = process.platform === 'win32';
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface GitRepo {
  repo: string;
  base: string;
  fix: string;
  g: (...args: string[]) => string;
}

/** A git repo with `files` committed as `base`, then `fix` changing lib.js. */
function gitRepo(files: Record<string, string>): GitRepo {
  const repo = tmp('z0-repo-');
  const g = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  g('init', '-q');
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) g('config', k, v);
  for (const [p, text] of Object.entries(files)) writeFileSync(join(repo, p), text);
  writeFileSync(join(repo, 'lib.js'), 'a - b\n');
  g('add', '.');
  g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'lib.js'), 'a + b, the fix that a later task must never see in an earlier workspace\n');
  g('commit', '-qam', 'fix');
  return { repo, base, fix: g('rev-parse', 'HEAD'), g };
}

/** An empty work repo set up the way the runner sets one up. */
function workRepo(): string {
  const work = tmp('z0-work-');
  execFileSync('git', ['init', '-q'], { cwd: work });
  for (const [k, v] of [['user.email', 'eval@localhost'], ['user.name', 'eval'], ['core.autocrlf', 'false'], ['core.eol', 'lf']]) execFileSync('git', ['config', k, v], { cwd: work });
  return work;
}

/** A dir holding empty stand-ins for the named tools, in both bare and .cmd form. */
function toolDir(names: string[]): string {
  const d = tmp('z0-tools-');
  for (const n of names) {
    writeFileSync(join(d, n), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(d, `${n}.cmd`), '@exit /b 0\r\n');
  }
  return d;
}

const PARENT = {
  KEEP_ME: 'k',
  anthropic_api_key: 'secret-lower',
  ANTHROPIC_BASE_URL: 'http://proxy.local',
  CLAUDE_CODE_USE_BEDROCK: '1',
  AWS_BEARER_TOKEN_BEDROCK: 'bearer',
  CLAUDE_CONFIG_DIR: '/operator/.claude',
  CODEX_HOME: '/operator/.codex',
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50',
  CLAUDECODE: '1',
  claude_code_subagent_model: 'm',
  HIPPO_SESSION_ID: 's',
  CLAUDE_CODE_OAUTH_TOKEN: 'tok',
};

describe('armEnv and childEnv', () => {
  const setup = () => {
    const out = tmp('z0-env-');
    const decoy = toolDir(['hippo']);
    const other = toolDir(['git']);
    return { run: runDirs(out, 'seqA', 'A2', 2), decoy, other, base: { ...PARENT, PATH: `${decoy}${delimiter}${other}` } };
  };

  it('strips every provider, Claude, Codex and hippo key, any case, and sets the run homes', () => {
    const { run, base } = setup();
    for (const arm of ARMS) {
      const env = armEnv(arm, { ...run, seed: 2 }, base);
      expect(env.KEEP_ME).toBe('k');
      for (const k of ['anthropic_api_key', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_BEARER_TOKEN_BEDROCK', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDECODE', 'claude_code_subagent_model', 'HIPPO_SESSION_ID']) {
        expect(env, `${arm} ${k}`).not.toHaveProperty(k);
      }
      expect(env.CLAUDE_CONFIG_DIR).toBe(run.claudeConfig);
      expect(env.CODEX_HOME).toBe(run.codexHome);
      expect(env.HIPPO_HOME).toBe(run.hippoHome);
      expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe(arm === 'A0' ? '1' : '0');
      expect(env.HIPPO_AGENT_MEMORY_TOOLS).toBe('claude-code,codex');
      expect(env.DISABLE_AUTOUPDATER).toBe('1');
      expect(env.EVAL_SEED).toBe('2');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
      expect(childEnv(env)).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    }
  });

  it('--pass-env copies exactly the named key', () => {
    const { run, base } = setup();
    const env = armEnv('A1', run, base, { passEnv: ['ANTHROPIC_BASE_URL'] });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://proxy.local');
    expect(env).not.toHaveProperty('anthropic_api_key');
    expect(env).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
  });

  it('--pass-env refuses, in any case, every key the runner sets itself, naming it', () => {
    const { run, base } = setup();
    const own = ['CLAUDE_CONFIG_DIR', 'codex_home', 'HIPPO_HOME', 'Claude_Code_Disable_Auto_Memory', 'HIPPO_AGENT_MEMORY_TOOLS', 'disable_autoupdater', 'EVAL_SEED', 'CLAUDE_CODE_OAUTH_TOKEN', 'PATH', 'Path'];
    for (const name of own) expect(() => armEnv('A1', run, base, { passEnv: ['ANTHROPIC_BASE_URL', name] }), name).toThrow(new RegExp(`--pass-env ${name}:`));
    expect(() => armEnv('A1', run, { ...base, CLAUDE_CODE_GIT_BASH_PATH: 'C:/bash.exe' }, { passEnv: ['CLAUDE_CODE_GIT_BASH_PATH'] })).not.toThrow();
  });

  it('puts bin/ first for A2/A5 only, drops the hippo dir for all, and childEnv drops bin/', () => {
    const { run, base, decoy, other } = setup();
    for (const arm of ARMS) {
      const parts = armEnv(arm, run, base).PATH.split(delimiter);
      expect(parts.includes(decoy), arm).toBe(false);
      expect(parts.includes(other), arm).toBe(true);
      expect(parts[0] === run.bin, arm).toBe(arm === 'A2' || arm === 'A5');
      expect(childEnv(armEnv(arm, run, base)).PATH.split(delimiter)).not.toContain(run.bin);
    }
    expect(childEnv(armEnv('A2', run, base), { keepBin: true }).PATH.split(delimiter)[0]).toBe(run.bin);
  });
});

describe('cleanPath', () => {
  it('removes a hippo launcher dir however it is written and keeps the rest verbatim', () => {
    const hippoDir = toolDir(['hippo']);
    const keep = toolDir(['git']);
    const forms = [hippoDir, `"${hippoDir}"`, `${hippoDir}/`, ` ${hippoDir} `, ...(win ? [`${hippoDir}\\`, hippoDir.toUpperCase()] : [])];
    for (const form of forms) {
      const { value, removed } = cleanPath(['', form, keep, ''].join(delimiter));
      expect(value, form).toBe(keep);
      expect(removed, form).toHaveLength(1);
    }
  });

  it('resolves relative entries against the cwd and expands %VAR% on win32', () => {
    const root = tmp('z0-rel-');
    mkdirSync(join(root, 'rel'));
    expect(cleanPath('rel', { cwd: root }).value).toBe(join(root, 'rel'));
    if (win) expect(cleanPath('%Z0_DIR%', { env: { Z0_DIR: toolDir(['hippo']) }, platform: 'win32' }).value).toBe('');
  });
});

describe('assertToolsResolve', () => {
  it('throws naming the removed dir when it also held node and npm', () => {
    const shared = toolDir(['hippo', 'node', 'npm']);
    const rest = toolDir(['npx', 'git', 'claude']);
    const { value, removed } = cleanPath(`${shared}${delimiter}${rest}`);
    expect(() => assertToolsResolve(value, 'claude', removed)).toThrow(new RegExp(`${shared.replace(/\\/g, '\\\\')}.*node, npm`));
  });

  it('passes when only hippo was removed, and rejects a claude path inside a removed dir', () => {
    const hippoDir = toolDir(['hippo', 'claude']);
    const rest = toolDir(['node', 'npm', 'npx', 'git', 'claude']);
    const { value, removed } = cleanPath(`${hippoDir}${delimiter}${rest}`);
    expect(() => assertToolsResolve(value, 'claude', removed)).not.toThrow();
    expect(() => assertToolsResolve(value, `"${join(hippoDir, 'claude.cmd')}" --flag`, removed)).toThrow(/claude \(/);
  });
});

describe('armSettings', () => {
  const hippo = { hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'SessionEnd', 'PreCompact', 'PostCompact', 'PostToolUseFailure'].map((e) => [e, [{ hooks: [] }]])) };

  it('gives each arm its prereg settings; A5 keeps only the two injection events', () => {
    expect(armSettings('A0', hippo)).toEqual({ autoMemoryEnabled: false });
    expect(armSettings('A1', hippo)).toEqual({});
    expect(armSettings('A2', hippo)).toEqual(hippo);
    expect(Object.keys(armSettings('A5', hippo).hooks).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect(() => armSettings('A9', hippo)).toThrow(/unknown arm/);
  });
});

describe('stub base commit', () => {
  it('is deterministic, replaces the root CLAUDE.md and keeps the rest of the base tree', () => {
    const repo = tmp('z0-stub-');
    const g = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    g('init', '-q');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 'T');
    writeFileSync(join(repo, 'CLAUDE.md'), 'native\n');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.js'), 'a\n');
    g('add', '.');
    g('commit', '-qm', 'base');
    const base = g('rev-parse', 'HEAD');
    const sha = stubBaseCommit(repo, base);
    expect(stubBaseCommit(repo, base)).toBe(sha);
    expect(g('show', `${sha}:CLAUDE.md`)).toBe(STUB_CLAUDE_MD.trim());
    expect(g('rev-parse', `${sha}^`)).toBe(base);
    expect(g('ls-tree', '-r', sha).replace(/^.*CLAUDE\.md\n?/m, '')).toBe(g('ls-tree', '-r', base).replace(/^.*CLAUDE\.md\n?/m, ''));
  });
});

describe('instruction files', () => {
  it('matches the prereg names at any depth and only rules under .claude/', () => {
    const yes = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'docs/AGENTS.md', 'a/b/CLAUDE.local.md', '.claude/rules/r.md', '.claude/rules/x/y.md'];
    const no = ['README.md', '.claude/CLAUDE.md', '.claude/agents/x.md', '.claude/settings.json', 'node_modules/p/CLAUDE.md', '.hippo/AGENTS.md', '.git/CLAUDE.md', 'sub/.claude/rules/r.md', 'claude.md.bak'];
    for (const p of yes) expect(isInstructionPath(p), p).toBe(true);
    for (const p of no) expect(isInstructionPath(p), p).toBe(false);
  });

  it('snapshots from disk, and the delta holds only paths whose bytes changed', () => {
    const work = tmp('z0-snap-');
    mkdirSync(join(work, 'node_modules', 'p'), { recursive: true });
    writeFileSync(join(work, 'node_modules', 'p', 'CLAUDE.md'), 'dep');
    writeFileSync(join(work, 'AGENTS.md'), 'a');
    writeFileSync(join(work, 'CLAUDE.md'), 'c');
    const before = instructionSnapshot(work);
    expect([...before.keys()].sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);
    writeFileSync(join(work, 'AGENTS.md'), 'a2');
    rmSync(join(work, 'CLAUDE.md'));
    mkdirSync(join(work, 'sub'));
    writeFileSync(join(work, 'sub', 'CLAUDE.md'), 's');
    const delta = instructionDelta(before, instructionSnapshot(work));
    expect(Object.fromEntries([...delta].map(([p, c]) => [p, [c.before?.toString() ?? null, c.after?.toString() ?? null]]))).toEqual({
      'AGENTS.md': ['a', 'a2'], 'CLAUDE.md': ['c', null], 'sub/CLAUDE.md': [null, 's'],
    });
  });
});

describe('applyInstructions', () => {
  const B = (s: string) => Buffer.from(s);
  const LINES = 'one\ntwo\nthree\nfour\nfive\n';
  const apply = (files: Record<string, string>, changes: Record<string, [string | null, string | null]>) => {
    const work = tmp('z0-apply-');
    const scratch = tmp('z0-apply-tmp-');
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(work, p)), { recursive: true });
      writeFileSync(join(work, p), text);
    }
    const baseline = instructionSnapshot(work);
    const delta = new Map(Object.entries(changes).map(([p, [before, after]]) => [p, { before: before === null ? null : B(before), after: after === null ? null : B(after) }]));
    const counts = applyInstructions(work, delta, baseline, scratch);
    const now = Object.fromEntries([...instructionSnapshot(work)].map(([p, b]) => [p, b.toString()]));
    expect(readdirSync(scratch)).toEqual([]);
    expect(readdirSync(work).filter((f) => !['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', 'docs', 'new'].includes(f))).toEqual([]);
    return { counts, now };
  };

  it('writes, deletes and merges per the carry rules', () => {
    const r = apply(
      { 'AGENTS.md': `NEW TOP\n${LINES.slice(4)}`, 'CLAUDE.md': 'same\n', 'CLAUDE.local.md': 'base moved\n', 'docs/AGENTS.md': 'x' },
      {
        'AGENTS.md': [LINES, `${LINES}appended\n`],
        'CLAUDE.md': ['same\n', 'agent edit\n'],
        'CLAUDE.local.md': ['old\n', null],
        'docs/AGENTS.md': ['x', null],
        'new/AGENTS.md': [null, 'brand new\n'],
      },
    );
    expect(r.now['AGENTS.md']).toBe(`NEW TOP\n${LINES.slice(4)}appended\n`);
    expect(r.now['CLAUDE.md']).toBe('agent edit\n');
    expect(r.now['CLAUDE.local.md']).toBe('base moved\n');
    expect(r.now['new/AGENTS.md']).toBe('brand new\n');
    expect(r.now).not.toHaveProperty('docs/AGENTS.md');
    expect(r.counts).toEqual({ carryMerges: 1, carryUnionMerges: 0, carryDeleteKept: 1 });
  });

  it('falls back to a union merge on a conflict and counts it', () => {
    const r = apply({ 'AGENTS.md': 'theirs\n' }, { 'AGENTS.md': ['base\n', 'mine\n'] });
    expect(r.now['AGENTS.md']).toBe('mine\ntheirs\n');
    expect(r.counts).toEqual({ carryMerges: 0, carryUnionMerges: 1, carryDeleteKept: 0 });
  });

  it('throws on a binary file instead of carrying it silently', () => {
    expect(() => apply({ 'AGENTS.md': 'a\0theirs' }, { 'AGENTS.md': ['a\0base', 'a\0mine'] })).toThrow(/AGENTS\.md/);
  });
});

describe('workspace checkout', () => {
  it('leaves an earlier task base unreachable once a later task checks out an older base, even behind agent refs, worktrees and nested repos', () => {
    const { repo, base, fix } = gitRepo({});
    const work = workRepo();
    const wg = (...args: string[]): string => execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();
    checkoutBase(repo, work, 'seqP', { id: 'p1', baseRef: fix });
    writeFileSync(join(work, 'lib.js'), 'agent edit\n');
    wg('stash');
    wg('branch', 'agent-work');
    wg('tag', 'agent-tag');
    wg('symbolic-ref', 'refs/heads/alias', 'refs/remotes/eval/base');
    const wtRoot = tmp('z0-wt-');
    wg('worktree', 'add', '-q', '--detach', join(wtRoot, 'wt'), 'HEAD');
    wg('worktree', 'add', '-q', '--detach', join(wtRoot, 'gone'), 'HEAD');
    wg('worktree', 'lock', join(wtRoot, 'gone'));
    rmSync(join(wtRoot, 'gone'), { recursive: true, force: true });
    wg('worktree', 'add', '-q', '--detach', join(wtRoot, 'nogit'), 'HEAD');
    rmSync(join(wtRoot, 'nogit', '.git'));
    wg('clone', '-q', '--no-checkout', '.', 'backup');
    mkdirSync(join(work, 'scratch'));
    const sg = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: join(work, 'scratch'), encoding: 'utf8' });
    sg('init', '-q');
    writeFileSync(join(work, 'scratch', 'notes.md'), 'the fix that a later task must never see\n');
    sg('add', '.');
    sg('commit', '-qm', 'notes');
    checkoutBase(repo, work, 'seqP', { id: 'p2', baseRef: base });
    expect(spawnSync('git', ['cat-file', '-e', `${fix}^{commit}`], { cwd: work }).status).not.toBe(0);
    const history = wg('log', '--all', '--reflog', '--format=%H %P');
    expect(history).toContain(base);
    expect(history).not.toContain(fix);
    expect(wg('log', '--all', '--reflog', '-p')).not.toContain('the fix that a later task must never see');
    expect(wg('for-each-ref', '--format=%(refname)')).toBe('refs/remotes/eval/base');
    expect(wg('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
    expect(existsSync(join(work, 'backup'))).toBe(false);
    expect(existsSync(join(work, 'scratch'))).toBe(false);
    expect(readFileSync(join(work, 'lib.js'), 'utf8')).toBe('a - b\n');
  });

  it('rebuilds a .git the agent replaced with a gitfile, keeping the runner config and a clean detached HEAD', () => {
    const { repo, base, fix } = gitRepo({});
    const work = workRepo();
    const wg = (...args: string[]): string => execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();
    checkoutBase(repo, work, 'seqG', { id: 'g1', baseRef: fix });
    const moved = join(tmp('z0-moved-'), 'git');
    renameSync(join(work, '.git'), moved);
    writeFileSync(join(work, '.git'), `gitdir: ${moved}\n`);
    const stub = checkoutBase(repo, work, 'seqG', { id: 'g2', baseRef: base });
    expect(statSync(join(work, '.git')).isDirectory()).toBe(true);
    expect(spawnSync('git', ['cat-file', '-e', `${fix}^{commit}`], { cwd: work }).status).not.toBe(0);
    expect(wg('rev-parse', 'HEAD')).toBe(stub);
    expect(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: work }).status).not.toBe(0);
    mkdirSync(join(work, '.hippo'));
    writeFileSync(join(work, '.hippo', 'store.db'), 'x');
    expect(wg('status', '--porcelain')).toBe('');
    expect(wg('config', 'core.autocrlf')).toBe('false');
    expect(wg('config', 'user.email')).toBe('eval@localhost');
  });

  /** gitRepo plus one commit adding `links` as 120000 entries; returns that commit. */
  const withLinks = (r: GitRepo, links: Record<string, string>): string => {
    for (const [rel, target] of Object.entries(links)) {
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: r.repo, input: target, encoding: 'utf8' }).trim();
      r.g('update-index', '--add', '--cacheinfo', `120000,${blob},${rel}`);
    }
    r.g('commit', '-qm', 'link');
    return r.g('rev-parse', 'HEAD');
  };

  it('refuses a task whose stub tree holds an instruction file as a symlink, before touching the workspace', () => {
    const r = gitRepo({ 'CLAUDE.md': 'native\n' });
    const head = withLinks(r, { 'AGENTS.md': 'CLAUDE.md' });
    const work = workRepo();
    expect(() => checkoutBase(r.repo, work, 'seqY', { id: 'y1', baseRef: head })).toThrow('Z0 task seqY/y1: instruction file AGENTS.md is a symlink in the task repo; Z0 does not carry symlinked instruction files, pick another task');
    expect(spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: work }).status).not.toBe(0);
  });

  it('refuses a symlinked .claude or .claude/rules, whose rules an agent could edit past the carry', () => {
    for (const rel of ['.claude', '.claude/rules']) {
      const r = gitRepo({});
      const head = withLinks(r, { [rel]: 'config/claude' });
      expect(() => checkoutBase(r.repo, workRepo(), 'seqD', { id: 'd1', baseRef: head }), rel).toThrow(`Z0 task seqD/d1: instruction file ${rel} is a symlink in the task repo`);
    }
  });

  it('checks out a repo whose root CLAUDE.md links to AGENTS.md, since the stub replaces that link', () => {
    const r = gitRepo({ 'AGENTS.md': 'native rules\n' });
    const head = withLinks(r, { 'CLAUDE.md': 'AGENTS.md' });
    const work = workRepo();
    checkoutBase(r.repo, work, 'seqC', { id: 'c1', baseRef: head });
    expect(readFileSync(join(work, 'CLAUDE.md'), 'utf8')).toBe(STUB_CLAUDE_MD);
    expect(readFileSync(join(work, 'AGENTS.md'), 'utf8')).toBe('native rules\n');
  });

  it('goldLines surfaces a git error instead of turning the leak check off', () => {
    const { repo, base, fix } = gitRepo({});
    expect(goldLines(repo, { baseRef: base, fixRef: fix })).toEqual(['a + b, the fix that a later task must never see in an earlier workspace']);
    expect(() => goldLines(repo, { baseRef: base, fixRef: 'no-such-ref' })).toThrow(/no-such-ref/);
  });
});

describe('hippo shim', () => {
  it.skipIf(!win)('hippo.cmd keeps its fake HOME to itself when called inside a longer cmd script', () => {
    const d = tmp('z0-shim-');
    writeHippoShim(join(d, 'bin'), join(d, 'fake-home'), 'real');
    const probe = join(d, 'probe.cmd');
    writeFileSync(probe, `@call "${join(d, 'bin', 'hippo.cmd')}" --version >nul\r\n@echo HOME=%HOME%\r\n`);
    const r = spawnSync('cmd.exe', ['/d', '/c', probe], { env: { ...process.env, HOME: 'operator-home' }, encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('HOME=operator-home');
  });
});

describe('per-run homes', () => {
  it('creates empty homes and throws when one is missing or not empty', () => {
    const run = runDirs(tmp('z0-homes-'), 'seqA', 'A1', 1);
    freshRunDirs(run);
    expect(() => assertFreshEmpty(run)).not.toThrow();
    writeFileSync(join(run.claudeConfig, 'settings.json'), '{}');
    expect(() => assertFreshEmpty(run)).toThrow(/not empty \(settings\.json\)/);
    rmSync(join(run.claudeConfig, 'settings.json'));
    rmSync(run.codexHome, { recursive: true });
    expect(() => assertFreshEmpty(run)).toThrow(/codex-home is missing/);
    freshRunDirs(run);
    expect(() => assertFreshEmpty(run)).not.toThrow();
  });
});

describe('ancestor preflight', () => {
  it('reports instruction files held by any ancestor up to stopAt, and nothing in a clean subtree', () => {
    const root = tmp('z0-anc-');
    const put = (rel: string, text = 'x') => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put('a/CLAUDE.md');
    put('r/.claude/rules/r.md');
    put('n/.claude/CLAUDE.md');
    for (const d of ['a/b/c', 'r/q', 'n/q', 'z/q']) mkdirSync(join(root, d), { recursive: true });
    expect(ancestorInstructionFiles(join(root, 'a', 'b', 'c'), { stopAt: root })).toEqual([join(root, 'a', 'CLAUDE.md')]);
    expect(ancestorInstructionFiles(join(root, 'r', 'q'), { stopAt: root })).toEqual([join(root, 'r', '.claude', 'rules')]);
    expect(ancestorInstructionFiles(join(root, 'n', 'q'), { stopAt: root })).toEqual([join(root, 'n', '.claude', 'CLAUDE.md')]);
    expect(ancestorInstructionFiles(join(root, 'z', 'q', 'not-yet'), { stopAt: root })).toEqual([]);
  });
});

describe('parseImportDryRun', () => {
  const run = runDirs(join(tmpdir(), 'z0-out'), 'seqA', 'A2', 1);
  const text = (lines: string[]) => ['Agent memories (dry run, nothing written):', ...lines, '', 'Imported 0 notes.'].join('\n');
  const fresh = [`  Claude Code: ${run.claudeConfig} (no memory folders found)`, `  Codex: ${run.codexHome} (no memory folders found)`];

  it('passes the exact fresh-run text and ignores four-space container lines', () => {
    expect(parseImportDryRun(text(fresh))).toEqual([{ label: 'Claude Code', home: run.claudeConfig }, { label: 'Codex', home: run.codexHome }]);
    expect(() => checkImportHomes(parseImportDryRun(text(fresh)), run, 'seqA/A2/seed1')).not.toThrow();
    expect(() => checkImportHomes(parseImportDryRun(text([fresh[0], '    project x: 1 note, into project', fresh[1]])), run, 'r')).not.toThrow();
  });

  it('fails on another tool, not found, a wrong home, two homes or a missing header', () => {
    const bad: Array<[string, RegExp]> = [
      [text([...fresh, '  Copilot: C:/x (no memory folders found)']), /seqA\/A2\/seed1.*Copilot/],
      [text([fresh[0], '  Codex: not found']), /not found/],
      [text([fresh[0], `  Codex: ${join(tmpdir(), 'operator', '.codex')}`]), /Codex/],
      [text([`  Claude Code: ${run.claudeConfig}, ${join(tmpdir(), 'other')}`, fresh[1]]), /Claude Code/],
    ];
    for (const [t, re] of bad) expect(() => checkImportHomes(parseImportDryRun(t), run, 'seqA/A2/seed1'), t).toThrow(re);
    expect(() => parseImportDryRun(fresh.join('\n'))).toThrow(/header/);
  });
});

describe('homes check (built CLI, no claude session)', () => {
  /** A fake operator HOME and APPDATA holding canary memories in every place an importer could look. */
  function operatorWithCanaries(): string {
    const home = tmp('z0-operator-');
    const notes: Array<[string, string]> = [
      [join(home, '.claude', 'projects', 'p', 'memory', 'canary.md'), '---\nname: canary\ntype: project\n---\nZ0-CANARY claude\n'],
      [join(home, '.codex', 'memories', 'memory_summary.md'), 'v1\n## User Profile\nZ0-CANARY codex\n'],
      [join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'memory-tool', 'memories', 'c.md'), 'Z0-CANARY copilot\n'],
    ];
    for (const [f, text] of notes) {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') });
    return home;
  }
  const decoy = () => {
    const d = toolDir(['hippo']);
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    process.env[key] = `${d}${delimiter}${process.env[key]}`;
    return d;
  };
  const runs = ARMS.map((arm) => ({ seq: 'seqH', arm, seed: 1 }));
  const textUnder = (dir: string): string => readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? textUnder(join(dir, e.name)) : readFileSync(join(dir, e.name), 'latin1'))).join('\n');

  it('passes for all four arms with a hippo decoy on PATH, and a real A2 init plus import keeps the canaries out', () => {
    operatorWithCanaries();
    decoy();
    const out = tmp('z0-check-');
    checkHomes({ outDir: out, runs, passEnv: [] });
    expect(existsSync(join(out, 'runs', 'seqH', 'A0', 'seed1'))).toBe(false);

    const run = runDirs(out, 'seqH', 'A2', 1);
    freshRunDirs(run);
    execFileSync('git', ['init', '-q'], { cwd: run.work });
    const env = { ...childEnv(armEnv('A2', run, process.env)), HOME: out, USERPROFILE: out };
    for (const args of [['init', '--no-schedule'], ['import', '--agents']]) execFileSync(process.execPath, [HIPPO_JS, ...args], { cwd: run.work, env, stdio: 'pipe' });
    expect(existsSync(join(run.work, '.hippo'))).toBe(true);
    expect(textUnder(run.root)).not.toContain('Z0-CANARY');
  }, 60_000);

  it('refuses a run dir that already holds data, naming it, and leaves the data in place', () => {
    operatorWithCanaries();
    const out = tmp('z0-check-');
    const occupied = runDirs(out, 'seqH', 'A1', 1);
    const evidence = join(occupied.work, 'transcript.jsonl');
    mkdirSync(occupied.work, { recursive: true });
    writeFileSync(evidence, 'earlier run\n');
    expect(() => checkHomes({ outDir: out, runs, passEnv: [] })).toThrow(new RegExp(`${esc(occupied.root)} already holds run data`));
    expect(readFileSync(evidence, 'utf8')).toBe('earlier run\n');
    expect(existsSync(join(out, 'runs', 'seqH', 'A0'))).toBe(false);
  }, 60_000);

  it('fails naming the run when a login profile puts the decoy hippo back on PATH', () => {
    const home = operatorWithCanaries();
    const d = decoy();
    const posix = win ? d.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, x: string) => `/${x.toLowerCase()}`) : d;
    for (const f of ['.bash_profile', '.profile']) writeFileSync(join(home, f), `export PATH="${posix}:$PATH"\n`);
    expect(() => checkHomes({ outDir: tmp('z0-check-'), runs, passEnv: [] })).toThrow(/seqH\/A0\/seed1.*hippo/);
  }, 60_000);
});
