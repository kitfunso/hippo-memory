/**
 * `hippo doctor`: read-only health report with a fix for every warn or fail.
 * Real stores, real settings files, the built CLI for the exit code.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { runDoctor, formatDoctor } from '../src/doctor.js';
import { startCompaction } from '../src/compaction-record.js';
import { repairProjects } from '../src/project-merge.js';
import { openHippoDb, openHippoDbReadOnly, closeHippoDb, getSchemaVersion, getCurrentSchemaVersion, setMeta } from '../src/db.js';

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const HIPPO_JS = resolve(__dirname, '..', 'bin', 'hippo.js');
const dirs: string[] = [];
const origHome = process.env.HIPPO_HOME;
const origConfigDir = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.HIPPO_HOME;
  else process.env.HIPPO_HOME = origHome;
  if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = origConfigDir;
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe('hippo doctor', () => {
  it('fails with a fix when there is no store, and creates nothing', () => {
    const cwd = tmp('doctor-empty-');
    process.env.HIPPO_HOME = join(cwd, 'global');
    const r = runDoctor({ cwd, home: cwd, version: 'test' });
    expect(r.ok).toBe(false);
    const store = r.checks.find((c) => c.id === 'store')!;
    expect(store.status).toBe('fail');
    expect(store.fix).toMatch(/hippo init/);
    expect(existsSync(join(cwd, '.hippo'))).toBe(false);
    expect(existsSync(join(cwd, 'global'))).toBe(false);
  });

  it('passes on a healthy project store and reports hooks, memories and sleep', () => {
    const cwd = tmp('doctor-ok-');
    process.env.HIPPO_HOME = join(cwd, 'global');
    initStore(join(cwd, '.hippo'));
    writeEntry(join(cwd, '.hippo'), createMemory('the staging deploy needs the VPN to reach the health check', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'hippo context --pinned-only --include-recent 5 --format additional-context' }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'hippo session-end --log-file x' }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: 'hippo pre-compact --log-file x' }] }],
      SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: 'hippo compact-resume' }] }],
      PostCompact: [{ hooks: [{ type: 'command', command: 'hippo post-compact' }] }],
      PostToolUseFailure: [{ matcher: '.*', hooks: [{ type: 'command', command: 'hippo capture-error' }] }],
    } }));
    const r = runDoctor({ cwd, home: cwd, version: 'test' });
    expect(r.ok).toBe(true);
    const status = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({ node: 'pass', store: 'pass', schema: 'pass', memories: 'info', failures: 'info', 'claude-code': 'pass', sleep: 'warn' });
    expect(formatDoctor(r)).toContain('fix: hippo sleep');
  });

  it('warns when the failure log table is gone, because the capture-error hook then logs nothing', () => {
    const cwd = tmp('doctor-failures-');
    process.env.HIPPO_HOME = join(cwd, 'global');
    initStore(join(cwd, '.hippo'));
    const db = openHippoDb(join(cwd, '.hippo'));
    db.exec('DROP TABLE failure_log');
    closeHippoDb(db);
    expect(runDoctor({ cwd, home: cwd, version: 'test' }).checks.find((c) => c.id === 'failures')).toMatchObject({ status: 'warn' });
  });

  it('names compactions left unfinished for over 10 minutes and points at sleep, ignoring live, finished and closed ones', () => {
    const cwd = tmp('doctor-compactions-');
    process.env.HIPPO_HOME = join(cwd, 'global');
    const hippoRoot = join(cwd, '.hippo');
    initStore(hippoRoot);
    const now = new Date('2026-09-29T12:00:00.000Z');
    expect(runDoctor({ cwd, home: cwd, version: 'test', now }).checks.find((c) => c.id === 'compactions')).toMatchObject({ status: 'pass', detail: '0 compactions recorded, none stuck' });

    const ago = (minutes: number): Date => new Date(now.getTime() - minutes * 60_000);
    const db = openHippoDb(hippoRoot);
    const begin = (session: string, at: Date, transcript: string | null = '/t.jsonl'): string =>
      startCompaction(db, 'default', { sessionId: session, originProject: '', trigger: 'auto', cwd: null, transcriptPath: transcript }, at);
    begin('started-stuck', ago(20));
    begin('started-live', ago(2));
    begin('started-transcript-gone', ago(40 * 24 * 60));
    begin('started-no-transcript', ago(20), null);
    const summarisedStuck = begin('summarised-stuck', ago(30));
    const summarisedLive = begin('summarised-live', ago(30));
    const finished = begin('finished', ago(30));
    const closed = begin('closed-no-summary', ago(30));
    const setStatus = db.prepare(`UPDATE compactions SET status = ?, summarised_at = ? WHERE id = ?`);
    setStatus.run('summarised', ago(20).toISOString(), summarisedStuck);
    setStatus.run('summarised', ago(3).toISOString(), summarisedLive);
    setStatus.run('done', ago(20).toISOString(), finished);
    setStatus.run('no-summary', ago(20).toISOString(), closed);
    closeHippoDb(db);

    const check = runDoctor({ cwd, home: cwd, version: 'test', now }).checks.find((c) => c.id === 'compactions')!;
    expect(check).toMatchObject({ status: 'warn', fix: expect.stringContaining('hippo sleep') });
    expect(check.detail).toBe('2 compactions unfinished after 10 minutes (1 with a summary whose memories are not saved yet, 1 with no summary yet)');
  });

  it('flags old Node, missing Claude Code hooks, and accepts the plugin instead of hooks', () => {
    const cwd = tmp('doctor-warn-');
    process.env.HIPPO_HOME = join(cwd, 'global');
    initStore(join(cwd, '.hippo'));
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude', 'settings.json'), '{}');
    const r = runDoctor({ cwd, home: cwd, version: 'test', nodeVersion: '20.11.0' });
    expect(r.checks.find((c) => c.id === 'node')!.status).toBe('fail');
    expect(r.checks.find((c) => c.id === 'claude-code')!.fix).toBe('hippo hook install claude-code');
    expect(r.checks.find((c) => c.id === 'memories')!.status).toBe('warn');

    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'hippo-memory@hippo-memory': true } }));
    expect(runDoctor({ cwd, home: cwd, version: 'test' }).checks.find((c) => c.id === 'claude-code')!.status).toBe('pass');
  });

  it('reads the Claude Code settings from CLAUDE_CONFIG_DIR when it is set, not from <home>/.claude', () => {
    const cwd = tmp('doctor-config-dir-');
    process.env.HIPPO_HOME = join(cwd, 'global');
    initStore(join(cwd, '.hippo'));
    const config = join(cwd, 'elsewhere');
    mkdirSync(config);
    writeFileSync(join(config, 'settings.json'), '{}');
    process.env.CLAUDE_CONFIG_DIR = config;
    expect(runDoctor({ cwd, home: cwd, version: 'test' }).checks.find((c) => c.id === 'claude-code')).toMatchObject({ status: 'warn', fix: 'hippo hook install claude-code' });
  });

  it('reads a Claude Code settings.json saved with a byte order mark, which install also reads', () => {
    const cwd = tmp('doctor-bom-');
    process.env.HIPPO_HOME = join(cwd, 'global');
    initStore(join(cwd, '.hippo'));
    mkdirSync(join(cwd, '.claude'));
    const commands = ['hippo context --pinned-only', 'hippo session-end', 'hippo pre-compact', 'hippo compact-resume', 'hippo post-compact', 'hippo capture-error'];
    const hooks = { Mixed: commands.map((command) => ({ hooks: [{ type: 'command', command }] })) };
    writeFileSync(join(cwd, '.claude', 'settings.json'), String.fromCodePoint(0xfeff) + JSON.stringify({ hooks }));
    expect(runDoctor({ cwd, home: cwd, version: 'test' }).checks.find((c) => c.id === 'claude-code')!.status).toBe('pass');
  });

  it('exits 1 with --json when a check fails', () => {
    const cwd = tmp('doctor-cli-');
    let status = 0;
    let out = '';
    try {
      out = execFileSync(process.execPath, [HIPPO_JS, 'doctor', '--json'], { cwd, env: { ...process.env, HIPPO_HOME: join(cwd, 'global'), HOME: cwd }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      // SAFETY: execFileSync attaches stdout and status to the thrown Error on a non-zero exit.
      const err = e as { stdout?: string; status?: number };
      out = err.stdout ?? '';
      status = err.status ?? 1;
    }
    expect(status).toBe(1);
    expect(JSON.parse(out).checks.find((c: { id: string }) => c.id === 'store').status).toBe('fail');
  });

  it('leaves an older store as it found it', () => {
    const cwd = tmp('doctor-readonly-');
    process.env.HIPPO_HOME = join(cwd, 'global');
    const hippoRoot = join(cwd, '.hippo');
    initStore(hippoRoot);
    const seed = openHippoDb(hippoRoot);
    setMeta(seed, 'schema_version', '45');
    seed.exec('DROP TABLE failure_log');
    closeHippoDb(seed); // last close checkpoints the WAL, so hippo.db alone is a stable hash target

    const before = sha256(join(hippoRoot, 'hippo.db'));
    const r = runDoctor({ cwd, home: cwd, version: 'test' });
    expect(r.checks.find((c) => c.id === 'schema')).toMatchObject({ status: 'info', detail: expect.stringContaining(`v${getCurrentSchemaVersion()}`) });
    expect(r.checks.find((c) => c.id === 'failures')).toMatchObject({ status: 'info', detail: 'no failure log yet (hippo creates it on the next write)' });
    expect(sha256(join(hippoRoot, 'hippo.db'))).toBe(before);

    const check = openHippoDbReadOnly(hippoRoot);
    expect(getSchemaVersion(check)).toBe(45);
    closeHippoDb(check);
  });

  it('flags a bare .hippo folder and creates nothing', () => {
    const cwd = tmp('doctor-bare-');
    process.env.HIPPO_HOME = join(cwd, 'global');
    mkdirSync(join(cwd, '.hippo'));
    const r = runDoctor({ cwd, home: cwd, version: 'test' });
    const store = r.checks.find((c) => c.id === 'store')!;
    expect(store.status).toBe('fail');
    expect(store.detail).toMatch(/\.hippo has no hippo\.db, so hippo commands run here stop at it$/);
    expect(existsSync(join(cwd, '.hippo', 'hippo.db'))).toBe(false);
    expect(r.checks.find((c) => c.id === 'schema')).toBeUndefined();
  });

  it('openHippoDbReadOnly refuses writes', () => {
    const cwd = tmp('doctor-ro-');
    process.env.HIPPO_HOME = join(cwd, 'global');
    const hippoRoot = join(cwd, '.hippo');
    initStore(hippoRoot);
    const db = openHippoDbReadOnly(hippoRoot);
    expect(() => db.exec('CREATE TABLE x (y)')).toThrow(/readonly/i);
    closeHippoDb(db);
  });

  it('a store that needs a newer binary names the upgrade', () => {
    const cwd = tmp('doctor-incompat-');
    process.env.HIPPO_HOME = join(cwd, 'global');
    const hippoRoot = join(cwd, '.hippo');
    initStore(hippoRoot);
    const seed = openHippoDb(hippoRoot);
    setMeta(seed, 'min_compatible_binary', '99.0.0');
    closeHippoDb(seed);

    const r = runDoctor({ cwd, home: cwd, version: 'test' });
    expect(r.checks.find((c) => c.id === 'schema')).toMatchObject({ status: 'fail', fix: 'npm install -g hippo-memory@latest' });
  });

  it('warns about merged rows the global store tagged user-global by mistake, and passes once repaired', () => {
    const cwd = tmp('doctor-projects-');
    const global = join(cwd, 'global');
    process.env.HIPPO_HOME = global;
    initStore(global);
    const parent = { ...createMemory('the proj-b deploy needs the staging VPN', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), origin_project: 'proj-b' };
    writeEntry(global, parent);
    writeEntry(global, { ...createMemory('merged: the proj-b deploy needs the VPN', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), source: 'consolidation', parents: [parent.id], origin_project: '' });

    expect(runDoctor({ cwd, home: cwd, version: 'test' }).checks.find((c) => c.id === 'projects'))
      .toMatchObject({ status: 'warn', fix: expect.stringContaining('hippo projects repair --global') });

    const db = openHippoDb(global);
    try {
      repairProjects(db, global, { tenantId: 'default', dryRun: false });
    } finally {
      closeHippoDb(db);
    }
    expect(runDoctor({ cwd, home: cwd, version: 'test' }).checks.find((c) => c.id === 'projects')!.status).toBe('pass');
  });
});
