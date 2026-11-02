// Z0 round 3 prereg item 5a: the arm env is an allowlist, armEnv refuses a secret-shaped name, and G1 reads each record's envKeys.
import { describe, it, expect } from 'vitest';
import { delimiter } from 'node:path';
import { armEnv, ARMS, ENV_ALLOWLIST, SECRET_SHAPED, TOKEN_KEY } from '../scripts/token-eval/arms.mjs';
import { runDirs } from '../scripts/token-eval/homes.mjs';
import { g1 } from '../scripts/token-eval/z0-gates.mjs';

const run = runDirs('unused-out-dir', 'seqA', 'A1', 1);
const SECRETS = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_TOKEN', 'CODEMAGIC_AUTH_TOKEN', 'COMPANIES_HOUSE_API_KEY', 'ELEXON_PORTAL_KEY', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'GOOGLE_API_KEY', 'PEXELS_API_KEY', 'SUPABASE_DB_DSN', 'TWOCHAIN_API_KEY', 'TYPESAFE_API_KEY'];
const base = (extra: Record<string, string> = {}) => ({ PATH: `/usr/bin${delimiter}/bin`, TEMP: '/tmp', JAVA_HOME: '/jdk', GRADLE_USER_HOME: '/gradle', [TOKEN_KEY]: 'tok', ...extra });

describe('armEnv allowlist (item 5a)', () => {
  it('drops a fake secret var, every operator secret name and any unlisted name, and keeps the listed ones', () => {
    const operator = Object.fromEntries(SECRETS.map((k) => [k, 'v']));
    for (const arm of ARMS) {
      const env = armEnv(arm, { ...run, seed: 1 }, base({ ...operator, FAKE_SERVICE_PASSWORD: 'x', ANTHROPIC_API_KEY: 'a', UNLISTED_NAME: 'u' }));
      for (const k of [...SECRETS, 'FAKE_SERVICE_PASSWORD', 'ANTHROPIC_API_KEY', 'UNLISTED_NAME']) expect(env, `${arm} ${k}`).not.toHaveProperty(k);
      expect([env.TEMP, env.JAVA_HOME, env.GRADLE_USER_HOME, env[TOKEN_KEY]], arm).toEqual(['/tmp', '/jdk', '/gradle', 'tok']);
      expect(Object.keys(env).every((k) => ENV_ALLOWLIST.some((n) => n.toUpperCase() === k.toUpperCase())), arm).toBe(true);
    }
  });

  it('matches names in any case and keeps one key for each runner name', () => {
    const env = armEnv('A1', { ...run, seed: 1 }, base({ java_home: '/jdk17', github_personal_access_token: 'v', claude_config_dir: '/operator/.claude', eval_seed: '99' }));
    expect(env.java_home).toBe('/jdk17');
    expect(env).not.toHaveProperty('github_personal_access_token');
    const own = Object.keys(env).filter((k) => ['CLAUDE_CONFIG_DIR', 'EVAL_SEED'].includes(k.toUpperCase()));
    expect(own.sort()).toEqual(['CLAUDE_CONFIG_DIR', 'EVAL_SEED']);
    expect([env.CLAUDE_CONFIG_DIR, env.EVAL_SEED]).toEqual([run.claudeConfig, '1']);
  });

  it('lists no secret-shaped name but the token, no ANTHROPIC_ name and no repeat', () => {
    expect(ENV_ALLOWLIST.filter((n) => n.toUpperCase() !== TOKEN_KEY && SECRET_SHAPED.test(n))).toEqual([]);
    expect(ENV_ALLOWLIST.filter((n) => /^ANTHROPIC_/i.test(n))).toEqual([]);
    const upper = ENV_ALLOWLIST.map((n) => n.toUpperCase());
    expect(new Set(upper).size).toBe(upper.length);
    expect(Object.isFrozen(ENV_ALLOWLIST)).toBe(true);
    expect(upper).toEqual(expect.arrayContaining([TOKEN_KEY, 'PATH', 'SYSTEMROOT', 'JAVA_HOME', 'GRADLE_USER_HOME', 'MAVEN_ARGS', 'CARGO_HOME', 'GOPATH', 'VIRTUAL_ENV', 'JULIA_DEPOT_PATH']));
  });

  it('throws on a secret-shaped allowlisted name, naming the key and how to fix it, never its value', () => {
    const value = 'zq-secret-value-0000';
    const list = [...ENV_ALLOWLIST, 'FAKE_VENDOR_API_KEY'];
    let message = '';
    try {
      armEnv('A1', { ...run, seed: 1 }, base({ FAKE_VENDOR_API_KEY: value }), { allowlist: list });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/FAKE_VENDOR_API_KEY.*remove it from ENV_ALLOWLIST/);
    expect(message).not.toContain(value);
    // The same list passes while the name is unset, so the throw reads the built env, not the list.
    expect(() => armEnv('A1', { ...run, seed: 1 }, base(), { allowlist: list })).not.toThrow();
  });

  it('throws on a --pass-env name that looks like a secret, and lets the token through', () => {
    expect(() => armEnv('A1', { ...run, seed: 1 }, base({ GOOGLE_API_KEY: 'v' }), { passEnv: ['GOOGLE_API_KEY'] })).toThrow(/GOOGLE_API_KEY.*ENV_ALLOWLIST/);
    expect(() => armEnv('A1', { ...run, seed: 1 }, base())).not.toThrow();
  });
});

describe('G1 envKeys conditions (item 5a)', () => {
  const clean = Object.keys(armEnv('A1', { ...run, seed: 1 }, base())).sort();
  const rec = (envKeys?: string[]) => ({ void: null, ...(envKeys ? { envKeys } : {}) });

  it('passes records whose envKeys sit inside the allowlist, in any case, and records with no envKeys', () => {
    const r = g1([rec(clean), rec(['PROGRAMFILES(X86)', 'programdata', 'Path', ...clean]), rec()], {});
    expect(r).toMatchObject({ pass: true, operatorCanaries: 0, envKeysOutside: {}, anthropicApiKeyRecords: 0 });
  });

  it('fails a record that holds GITHUB_PERSONAL_ACCESS_TOKEN and counts the records for each name', () => {
    const r = g1([rec([...clean, 'GITHUB_PERSONAL_ACCESS_TOKEN', 'SUPABASE_DB_DSN']), rec([...clean, 'github_personal_access_token']), rec(clean)], {});
    expect(r).toMatchObject({ pass: false, operatorCanaries: 0, envKeysOutside: { GITHUB_PERSONAL_ACCESS_TOKEN: 2, SUPABASE_DB_DSN: 1 }, anthropicApiKeyRecords: 0 });
  });

  it('fails a record that holds ANTHROPIC_API_KEY and counts it on its own line too', () => {
    const r = g1([rec([...clean, 'Anthropic_Api_Key']), rec(clean)], {});
    expect(r).toMatchObject({ pass: false, envKeysOutside: { ANTHROPIC_API_KEY: 1 }, anthropicApiKeyRecords: 1 });
  });

  it('reads the 11 round 2 operator secret names as outside the list', () => {
    const r = g1([rec([...clean, ...SECRETS])], {});
    expect(Object.keys(r.envKeysOutside).sort()).toEqual([...SECRETS].sort());
    expect(r.pass).toBe(false);
  });
});
