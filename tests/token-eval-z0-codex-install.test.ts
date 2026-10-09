// Z0 X2's hippo install for Codex: the install env and probe, the operator launcher guard, the trust seam and the homes check (E6 plan tests 10, 11, 12, 20).
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import { installEnv, assertInstallProbe, assertWrapperRuns, guardLaunchers, installHippoCodex, checkInstaller } from '../scripts/token-eval/codex-install.mjs';
import { closeVault } from '../scripts/token-eval/codex-auth.mjs';
import { checkHomes, runDirs } from '../scripts/token-eval/homes.mjs';
import { HIPPO_JS, pathKey } from '../scripts/token-eval/exec.mjs';
import { cleanup, tmp, isolate, makeRepo, find } from './fixtures/z0-harness.js';
import { operator, wrapOperator, codexCtx, codexRun, xRun, xTrio, xIsolate, xRecords, fakeSeen } from './fixtures/z0-codex-harness.js';
import type { CodexCtx, CodexOpts } from './fixtures/z0-codex-harness.js';

afterEach(cleanup);

const opened: CodexCtx[] = [];
afterEach(() => {
  for (const ctx of opened.splice(0)) closeVault(ctx.codexVault);
});

const WHERE = 'seqX X2 seed1';
const MARK = 'hippo codex wrapper';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const text = (f: string) => readFileSync(f, 'utf8');
/** Every file in `dir` with its hash, so a changed, new or missing operator file shows. */
const dirState = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map((n) => [n, createHash('sha256').update(readFileSync(join(dir, n))).digest('hex')]));
const metaFile = (run: { dirs: { home: string } }) => join(run.dirs.home, '.hippo', 'integrations', 'codex.json');
const hooksFile = (run: { dirs: { codexHome: string } }) => join(run.dirs.codexHome, 'hooks.json');

/** An isolated operator and ctx; `x2(seed)` is a fresh X2 run with its launcher, under one out dir. */
function setup(name: string, opts: CodexOpts = {}) {
  const { out } = isolate(name);
  const op = operator(name);
  const ctx = codexCtx(op, opts);
  opened.push(ctx);
  return { out, op, ctx, x2: (seed = 1) => codexRun(ctx, out, 'X2', seed) };
}

/** The install env with the operator's dir put first on PATH: the env a wrong build would give the install. */
function operatorFirst<E extends Record<string, string | undefined>>(env: E, operatorBin: string): E {
  const key = pathKey(env);
  return { ...env, [key]: `${operatorBin}${delimiter}${env[key]}` };
}

describe('the X2 install probe (test 11)', () => {
  it('refuses a PATH that finds codex outside the run bin, a HOME outside the run, metadata already there, and a missing launcher', () => {
    const { op, x2 } = setup('probe');
    const run = x2();
    const env = installEnv(run);
    expect(() => assertInstallProbe(run, env)).not.toThrow();
    expect(() => assertInstallProbe(run, operatorFirst(env, op.bin))).toThrow(new RegExp(`would wrap ${esc(op.launcher)}, not the run launcher`));
    expect(() => assertInstallProbe(run, { ...env, HOME: op.home, USERPROFILE: op.home })).toThrow(/outside the run's home/);
    mkdirSync(dirname(metaFile(run)), { recursive: true });
    writeFileSync(metaFile(run), '{}');
    expect(() => assertInstallProbe(run, env)).toThrow(/codex\.json already exists/);
    rmSync(metaFile(run));
    rmSync(run.codexLauncher);
    expect(() => assertInstallProbe(run, env)).toThrow(/would wrap no codex at all/);
  }, 60_000);

  it('gives the install one PATH key, the run bin then the node dir, when the run env holds both Path and PATH', () => {
    const { op, x2 } = setup('onekey');
    const run = x2();
    // Whichever spelling the run env lacks names the operator's dir, as a second key in a Windows env can.
    run.env[pathKey(run.env) === 'PATH' ? 'Path' : 'PATH'] = op.bin;
    const env = installEnv(run);
    const keys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
    expect(keys).toHaveLength(1);
    expect(env[keys[0]]).toBe(`${run.dirs.bin}${delimiter}${dirname(process.execPath)}`);
    expect([env.HOME, env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA]).toEqual([run.dirs.home, run.dirs.home, join(run.dirs.home, 'appdata'), join(run.dirs.home, 'appdata')]);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(() => assertInstallProbe(run, env)).not.toThrow();
  }, 60_000);

  it('refuses through the install before any install call, so nothing is written', () => {
    const { op, ctx, x2 } = setup('refuse');
    const run = x2();
    const before = dirState(op.bin);
    const launcher = text(run.codexLauncher);
    expect(() => installHippoCodex(ctx, run, operatorFirst(installEnv(run), op.bin))).toThrow(/would wrap .*nothing was installed/);
    expect(dirState(op.bin)).toEqual(before);
    expect(text(run.codexLauncher)).toBe(launcher);
    expect([existsSync(hooksFile(run)), existsSync(join(run.dirs.home, '.hippo'))]).toEqual([false, false]);
  }, 60_000);

  it('installs into the run launcher when the run env holds Path and PATH, and leaves the operator files alone', () => {
    const { op, ctx, x2 } = setup('twokeys');
    const run = x2();
    run.env[pathKey(run.env) === 'PATH' ? 'Path' : 'PATH'] = op.bin;
    const before = dirState(op.bin);
    installHippoCodex(ctx, run);
    expect(text(run.codexLauncher)).toContain(MARK);
    expect(dirState(op.bin)).toEqual(before);
  }, 120_000);
});

describe('the operator launcher guard (plan R5)', () => {
  it('puts changed codex files back byte for byte, removes new ones, and abandons the run', () => {
    const { op, ctx } = setup('guard');
    const stray = join(op.bin, 'codex.ps1');
    writeFileSync(stray, 'operator ps1\n');
    const before = dirState(op.bin);
    const change = () => {
      wrapOperator(op, { metadata: false });
      rmSync(stray);
    };
    expect(() => guardLaunchers(ctx, WHERE, change)).toThrow(/changed the operator's Codex launchers .*put back byte for byte.*abandoned/s);
    expect(dirState(op.bin)).toEqual(before);
  });

  it('passes an unchanged dir, and lets the install\'s own error through', () => {
    const { op, ctx } = setup('guardok');
    const before = dirState(op.bin);
    expect(guardLaunchers(ctx, WHERE, () => 7)).toBe(7);
    expect(() => guardLaunchers(ctx, WHERE, () => { throw new Error('install exited 1'); })).toThrow('install exited 1');
    expect(dirState(op.bin)).toEqual(before);
  });
});

describe('the wrapper the install leaves (test 10)', () => {
  it('refuses a wrapper whose hippo CLI does not exist, naming the path', () => {
    const dir = tmp('z0-wrap-');
    const wrapper = (cli: string) => {
      const f = join(dir, 'codex.cmd');
      writeFileSync(f, `@echo off\r\nREM ${MARK}\r\n"${process.execPath}" "${cli}" codex-run -- %*\r\n`);
      return f;
    };
    const dead = join(dir, 'dist', 'bin', 'hippo.js');
    expect(() => assertWrapperRuns(wrapper(dead), WHERE)).toThrow(new RegExp(`runs ${esc(dead)}, which does not exist`));
    expect(() => assertWrapperRuns(wrapper(HIPPO_JS), WHERE)).not.toThrow();
  });

  it('wraps each seed\'s own launcher with this checkout\'s hippo, keeps the operator files, and puts metadata and hooks.json under the run', () => {
    const { op, ctx, x2 } = setup('install');
    const before = dirState(op.bin);
    for (const seed of [1, 2]) {
      const run = x2(seed);
      installHippoCodex(ctx, run);
      // A HOME shared by the seeds would hold seed 1's metadata, and hippo would skip wrapping seed 2.
      const wrapper = text(run.codexLauncher);
      expect(wrapper, `seed${seed}`).toContain(MARK);
      expect(wrapper, `seed${seed}`).toContain(HIPPO_JS);
      const meta = JSON.parse(text(metaFile(run)));
      expect([meta.commandPath, meta.originalCodexPath, dirname(meta.realCodexPath)]).toEqual([run.codexLauncher, run.codexLauncher, run.dirs.bin]);
      expect(text(meta.realCodexPath)).toContain(op.launcher);
      const hooks = JSON.parse(text(hooksFile(run))).hooks;
      expect([hooks.UserPromptSubmit[0].hooks[0].command, hooks.SessionStart[0].hooks[0].command]).toEqual([expect.stringContaining('hippo context --pinned-only'), 'hippo compact-resume']);
    }
    expect(dirState(op.bin)).toEqual(before);
    expect(existsSync(join(op.home, '.hippo'))).toBe(false);
  }, 120_000);
});

describe('the hook trust seam (test 12)', () => {
  const TRUST = "[hooks.state.'{hooksJson}:user_prompt_submit:0:0']\nenabled = true\ntrusted_hash = \"sha256:z0-test\"\n";
  // The apply prompt shares words with the stored teach message: given a prompt, hippo's hook recalls by it and not by recency.
  const teachStored = { 't-xa': 'LESSON_BAD\nCAPTURE_TEACH', 'a-xa': 'the checker reads a rule' };
  const trustFile = () => {
    const f = join(tmp('z0-trust-'), 'trust.toml');
    writeFileSync(f, TRUST);
    return f;
  };

  it('none: no trust text and no flag reach Codex, and hippo\'s hooks never fire', async () => {
    const { out, op, codexLog } = xIsolate('trustnone');
    await xRun(xTrio(makeRepo(), teachStored), ['X2'], out, op);
    const a = find(xRecords(out), 'X2', 'a-xa');
    expect([a.invalid, a.codexHookTrust, a.codexHooksFired?.injections]).toEqual([null, 'none', 0]);
    const seen = fakeSeen(codexLog);
    expect(seen.some((s) => s.config?.includes('hooks.state') || s.argv.includes('--dangerously-bypass-hook-trust'))).toBe(false);
  }, 240_000);

  it('file: the same trust text, with each run\'s own hooks.json path, is in all four X arms\' config.toml', () => {
    const { ctx, out } = setup('trustfile', { codexHookTrust: `file:${trustFile()}` });
    const configs = ['X1', 'X2', 'X3', 'X4'].map((arm) => {
      const run = codexRun(ctx, out, arm);
      const toml = text(join(run.dirs.codexHome, 'config.toml'));
      expect(toml, arm).toContain(`[hooks.state.'${hooksFile(run)}:user_prompt_submit:0:0']`);
      return toml.replaceAll(hooksFile(run), '{hooksJson}');
    });
    expect(new Set(configs).size).toBe(1);
    expect(configs[0]).toContain(TRUST.trimEnd());
  });

  it('file: hippo\'s hooks fire in X2 and book the injection under the Codex thread', async () => {
    const { out, op } = xIsolate('trustx2');
    await xRun(xTrio(makeRepo(), teachStored), ['X2'], out, op, { codexHookTrust: `file:${trustFile()}` });
    const a = find(xRecords(out), 'X2', 'a-xa');
    expect([a.invalid, a.void, a.codexHookTrust]).toEqual([null, null, 'file']);
    expect(a.codexHooksFired?.injections).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it('flag: every Codex session gets the bypass flag, and hippo\'s hooks fire in X2', async () => {
    const { out, op, codexLog } = xIsolate('trustflag');
    await xRun(xTrio(makeRepo(), teachStored), ['X2'], out, op, { codexHookTrust: 'flag' });
    const a = find(xRecords(out), 'X2', 'a-xa');
    expect([a.invalid, a.void, a.codexHookTrust]).toEqual([null, null, 'flag']);
    expect(a.codexHooksFired?.injections).toBeGreaterThanOrEqual(1);
    const seen = fakeSeen(codexLog);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.argv.includes('--dangerously-bypass-hook-trust'))).toBe(true);
  }, 240_000);
});

describe('--check-homes on an X2 run after the install (test 20)', () => {
  it('checks the importer with the wrapper home and hooks.json in place, and leaves the operator files and no run dir', () => {
    const { out, op } = xIsolate('check');
    const before = dirState(op.bin);
    const install = checkInstaller(op.launcher, op.env);
    const installed: boolean[] = [];
    const spy = (run: Parameters<typeof install>[0]) => {
      install(run);
      installed.push(existsSync(hooksFile(run)) && existsSync(metaFile(run)));
    };
    checkHomes({ outDir: out, runs: [{ seq: 'seqH', arm: 'X1', seed: 1 }, { seq: 'seqH', arm: 'X2', seed: 1 }], passEnv: [], install: spy });
    expect(installed).toEqual([true]);
    expect(dirState(op.bin)).toEqual(before);
    expect(existsSync(runDirs(out, 'seqH', 'X2', 1).root)).toBe(false);
  }, 120_000);
});
