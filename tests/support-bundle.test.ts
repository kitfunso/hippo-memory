/** `hippo support-bundle`: read-only, secret-free, one redacted JSON file. Real stores, canaries built at runtime. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { buildSupportBundle } from '../src/support-bundle.js';
import { openHippoDb, openHippoDbReadOnly, closeHippoDb, getSchemaVersion, getCurrentSchemaVersion } from '../src/db.js';
import type { JsonObject, JsonValue } from '../src/working-memory.js';

const HIPPO_JS = resolve(__dirname, '..', 'bin', 'hippo.js');
const dirs: string[] = [];
const origHippoHome = process.env.HIPPO_HOME;

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (origHippoHome === undefined) delete process.env.HIPPO_HOME;
  else process.env.HIPPO_HOME = origHippoHome;
  delete process.env.HIPPO_FAKE;
});

function tmp(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function isString(v: JsonValue): v is string {
  return typeof v === 'string';
}

/** Every key and string in a bundle, lowercased. Raw JSON text doubles Windows backslashes, so a substring check on it proves nothing. */
function bundleText(bundle: JsonObject): string[] {
  const out: string[] = [];
  JSON.parse(JSON.stringify(bundle), (key: string, value: JsonValue) => {
    out.push(key.toLowerCase());
    if (isString(value)) out.push(value.toLowerCase());
    return value;
  });
  return out;
}

interface Seeded {
  home: string;
  cwd: string;
  hippoRoot: string;
  memoryCanary: string;
  pwCanary: string;
  qCanary: string;
  fCanary: string;
  keyCanary: string;
  authCanary: string;
  envCanary: string;
  ghpCanary: string;
  skCanary: string;
  bearerCanary: string;
  jwtCanary: string;
}

function seed(): Seeded {
  const home = tmp('hippo-bundle-home-');
  const cwd = join(home, 'proj');
  mkdirSync(cwd, { recursive: true });
  const hippoRoot = join(cwd, '.hippo');
  initStore(hippoRoot);

  const memoryCanary = `canary-memory-${randomUUID()}`;
  writeEntry(hippoRoot, createMemory(memoryCanary));

  const pwCanary = `pw-${randomUUID()}`;
  const qCanary = `q-${randomUUID()}`;
  const fCanary = `f-${randomUUID()}`;
  const keyCanary = `k-${randomUUID()}`;
  const authCanary = `a-${randomUUID()}`;
  writeFileSync(join(hippoRoot, 'config.json'), JSON.stringify({
    embeddings: {
      apiBaseUrl: `https://user:${pwCanary}@proxy.example.com/v1?key=${qCanary}#${fCanary}`,
      apiKey: keyCanary,
      authToken: authCanary,
    },
  }));

  const logsDir = join(home, '.hippo', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const ghpCanary = 'ghp_' + 'A'.repeat(36);
  const skCanary = 'sk-' + randomUUID().replace(/-/g, '');
  const bearerCanary = 'Bearer ' + randomUUID().replace(/-/g, '');
  const jwtCanary = `eyJ${'A'.repeat(10)}.eyJ${'B'.repeat(10)}.${'C'.repeat(10)}`;
  writeFileSync(join(logsDir, 'last-sleep.log'), [
    `memory seen: ${memoryCanary}`,
    `token issued ${ghpCanary}`,
    `fetch failed: ${skCanary}`,
    `saw header ${bearerCanary}`,
    `jwt ${jwtCanary}`,
    `home is ${home} now`,
    `saved to ${home}.`,
    `other user ${join(`${home}ty`, 'x')}`,
    '',
  ].join('\n'));

  process.env.HIPPO_HOME = join(home, 'unused-global');
  const envCanary = `env-${randomUUID()}`;
  process.env.HIPPO_FAKE = envCanary;

  return { home, cwd, hippoRoot, memoryCanary, pwCanary, qCanary, fCanary, keyCanary, authCanary, envCanary, ghpCanary, skCanary, bearerCanary, jwtCanary };
}

describe('buildSupportBundle', () => {
  it('the default bundle redacts every canary, home form and secret, and keeps what it should', () => {
    const s = seed();
    const bundle = buildSupportBundle({ cwd: s.cwd, home: s.home, version: 'test', includeLogs: false, now: new Date() });
    const text = bundleText(bundle);

    // The unresolved tmpdir form is the 8.3 short name on Windows (KIT~1.SOF), which no home form covers.
    const homes = [s.home, join(tmpdir(), basename(s.home)), homedir()];
    const forbidden = [
      s.memoryCanary, s.pwCanary, s.qCanary, s.fCanary, s.keyCanary, s.authCanary, s.envCanary,
      ...homes, ...homes.map((h) => h.replace(/\\/g, '/')),
    ];
    for (const f of forbidden) expect(text.filter((t) => t.includes(f.toLowerCase())), f).toEqual([]);

    const json = JSON.stringify(bundle, null, 2);
    expect(json).toContain('https://proxy.example.com/v1');
    expect(json).toContain('"memories": 1');
    expect(json).toContain('last-sleep.log');
    expect(json).toContain('HIPPO_FAKE');

    const parsed = JSON.parse(json);
    expect(parsed.stores).toHaveLength(1);
    expect(parsed.stores[0].schemaVersion).toBe(getCurrentSchemaVersion());
    expect(parsed.stores[0].path.startsWith('~')).toBe(true);
    expect(Array.isArray(parsed.doctor.checks)).toBe(true);
    expect(parsed.doctor.checks.length).toBeGreaterThan(0);
    expect(parsed.logs.tails).toBeUndefined();
  });

  it('includeLogs adds tails with known secret shapes gone; memory text in a log is not (documented opt-in)', () => {
    const s = seed();
    const bundle = buildSupportBundle({ cwd: s.cwd, home: s.home, version: 'test', includeLogs: true, now: new Date() });
    const parsed = JSON.parse(JSON.stringify(bundle));
    // SAFETY: buildLogsSection always fills tails[name] with the string[] lines returned by tailLogFile.
    const tail = (parsed.logs.tails['last-sleep.log'] as string[]).join('\n');

    expect(tail).not.toContain(s.ghpCanary);
    expect(tail).not.toContain(s.skCanary);
    expect(tail).not.toContain(s.bearerCanary);
    expect(tail).not.toContain(s.jwtCanary);
    expect(tail).toContain('[REDACTED]');
    expect(tail).toContain(s.memoryCanary);

    expect(tail).toContain('home is ~ now');
    expect(tail).toContain('saved to ~.');
    expect(tail).toContain(`${basename(s.home)}ty`);
    expect(tail).not.toContain('~ty');
  });

  it('never writes to the store: hippo.db bytes and an older schema_version are unchanged', () => {
    const s = seed();
    const db = openHippoDb(s.hippoRoot);
    db.prepare(`UPDATE meta SET value = '45' WHERE key = 'schema_version'`).run();
    closeHippoDb(db);

    const before = sha256(join(s.hippoRoot, 'hippo.db'));
    buildSupportBundle({ cwd: s.cwd, home: s.home, version: 'test', includeLogs: false, now: new Date() });
    expect(sha256(join(s.hippoRoot, 'hippo.db'))).toBe(before);

    const check = openHippoDbReadOnly(s.hippoRoot);
    expect(getSchemaVersion(check)).toBe(45);
    closeHippoDb(check);
  });

  it('a bare cwd has no stores; a bare .hippo is one error entry', () => {
    const home = tmp('hippo-bundle-empty-home-');
    const cwd = join(home, 'proj');
    mkdirSync(cwd, { recursive: true });
    process.env.HIPPO_HOME = join(home, 'unused-global');

    const bundle = buildSupportBundle({ cwd, home, version: 'test', includeLogs: false, now: new Date() });
    const parsed = JSON.parse(JSON.stringify(bundle));
    expect(parsed.stores).toEqual([]);
    expect(parsed.doctor.checks.find((c: { id: string }) => c.id === 'store').status).toBe('fail');

    mkdirSync(join(cwd, '.hippo'));
    const bare = JSON.parse(JSON.stringify(
      buildSupportBundle({ cwd, home, version: 'test', includeLogs: false, now: new Date() }),
    ));
    expect(bare.stores).toHaveLength(1);
    expect(bare.stores[0].error).toMatch(/no hippo\.db here/);
  });
});

describe('hippo support-bundle (CLI)', () => {
  it('writes once, refuses to overwrite, and rejects a bare --out', () => {
    const home = tmp('hippo-bundle-cli-');
    const env = { ...process.env, HOME: home, USERPROFILE: home, HIPPO_HOME: join(home, 'global'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    execFileSync(process.execPath, [HIPPO_JS, 'init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd: home, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

    const target = join(home, 'x.json');
    execFileSync(process.execPath, [HIPPO_JS, 'support-bundle', '--out', target], { cwd: home, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = readFileSync(target, 'utf8');
    expect(() => JSON.parse(first)).not.toThrow();

    let status = 0;
    try {
      execFileSync(process.execPath, [HIPPO_JS, 'support-bundle', '--out', target], { cwd: home, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      // SAFETY: execFileSync attaches status to the thrown Error on a non-zero exit.
      status = (e as { status?: number }).status ?? 1;
    }
    expect(status).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe(first);

    let bareStatus = 0;
    try {
      execFileSync(process.execPath, [HIPPO_JS, 'support-bundle', '--out'], { cwd: home, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      // SAFETY: execFileSync attaches status to the thrown Error on a non-zero exit.
      bareStatus = (e as { status?: number }).status ?? 1;
    }
    expect(bareStatus).toBe(1);
  });
});
