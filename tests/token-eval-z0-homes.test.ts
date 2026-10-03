// Z0 runner units: arm env and PATH, settings, per-run homes, workspace carry and the preflight checks.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { armEnv, childEnv, armSettings, cleanPath, assertToolsResolve, ARMS } from '../scripts/token-eval/arms.mjs';
import { runDirs, freshRunDirs, assertFreshEmpty } from '../scripts/token-eval/homes.mjs';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const win = process.platform === 'win32';

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
