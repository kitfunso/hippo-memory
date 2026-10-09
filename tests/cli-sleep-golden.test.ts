// Pins `hippo sleep` stdout, stderr, exit code and log file over its flags on a seeded store, so moving the
// sleep verb out of cli.ts, or any later refactor of it, that changes a byte fails here.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, Layer, type MemoryEntry } from '../src/core/memory.js';
import { ownStderr } from './_helpers/own-stderr.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const FAKE_NOW = '2026-02-01T00:00:00.000Z';
const DROP_ENV = ['HIPPO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'HIPPO_TENANT', 'HIPPO_HOME'];

let template: string;

function seeded(content: string, id: string, created: string, extra: Partial<MemoryEntry> = {}, opts: Partial<Parameters<typeof createMemory>[1]> = {}): MemoryEntry {
  // createMemory decays strength over the real milliseconds it runs, so a fixed value keeps snapshots stable.
  return { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, ...opts }), id, created, last_retrieved: created, valid_from: created, strength: 1, ...extra };
}

function seedLocal(hippoRoot: string): void {
  initStore(hippoRoot);
  const rows: MemoryEntry[] = [
    seeded('deploy rollback needs the database migration reverted before the api restarts', 'mem_sleep_a', '2026-01-20T00:00:00.000Z', {}, { tags: ['deploy'] }),
    seeded('deploy rollback needs the database migration reverted before the api restarts again', 'mem_sleep_b', '2026-01-21T00:00:00.000Z', {}, { tags: ['deploy'] }),
    seeded('deploy rollback needs the database migration reverted before the api service restarts', 'mem_sleep_c', '2026-01-22T00:00:00.000Z', {}, { tags: ['deploy'] }),
    seeded('the billing export job writes csv files to the shared bucket every night', 'mem_sleep_dup1', '2026-01-10T00:00:00.000Z'),
    seeded('the billing export job writes csv files to the shared bucket every night', 'mem_sleep_dup2', '2026-01-11T00:00:00.000Z'),
    seeded('an old note about the retired staging cluster that nobody reads', 'mem_sleep_faded', '2025-03-01T00:00:00.000Z', { strength: 0.01, last_retrieved: '2025-03-01T00:00:00.000Z' }),
    seeded('placeholder junk', 'mem_sleep_junk', '2026-01-25T00:00:00.000Z', { content: 'ok' }),
    seeded('never force push the release branch, it breaks the tag pipeline', 'mem_sleep_pinned', '2026-01-05T00:00:00.000Z', {}, { pinned: true, tags: ['error', 'git'] }),
    seeded('ran the canary and promoted it after the error budget held', 'mem_sleep_trace', '2026-01-23T00:00:00.000Z', {}, { layer: Layer.Trace, trace_outcome: 'success' }),
    seeded('the flaky login test fails when the clock crosses midnight utc', 'mem_sleep_valued', '2026-01-15T00:00:00.000Z', { retrieval_count: 6, outcome_positive: 4 }, { tags: ['error', 'testing'] }),
  ];
  for (const row of rows) writeEntry(hippoRoot, row);
}

interface Case { name: string; args: string[]; uninitialised?: boolean; logFile?: boolean }

const CASES: Case[] = [
  { name: 'sleep default', args: ['sleep'] },
  { name: 'sleep --json', args: ['sleep', '--json'] },
  { name: 'sleep --dry-run', args: ['sleep', '--dry-run'] },
  { name: 'sleep --dry-run --json', args: ['sleep', '--dry-run', '--json'] },
  { name: 'sleep --no-learn --no-share', args: ['sleep', '--no-learn', '--no-share'] },
  { name: 'sleep --dry-run --no-learn', args: ['sleep', '--dry-run', '--no-learn'] },
  { name: 'sleep --log-file', args: ['sleep'], logFile: true },
  { name: 'sleep on an uninitialised store', args: ['sleep'], uninitialised: true },
];

function normalise(text: string, home: string): string {
  return ownStderr(text)
    .split(home).join('<home>')
    .split(home.replace(/\\/g, '/')).join('<home>')
    .replace(/<home>\\/g, '<home>/')
    .replace(/\(node:\d+\)/g, '(node:<pid>)')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>');
}

interface RunOutput { status: number | null; stdout: string; stderr: string; log?: string }

function run(c: Case): RunOutput {
  // Real path: the CLI prints resolved paths, and macOS spells the temp root through the /var symlink.
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'hippo-sleep-golden-')));
  try {
    if (!c.uninitialised) cpSync(template, join(home, '.hippo'), { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of DROP_ENV) delete env[k];
    // The agent-memory import reads the home dir, so every home a run could see is the temp dir.
    Object.assign(env, {
      HIPPO_HOME: join(home, 'global-hippo'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1', HIPPO_FAKE_NOW: FAKE_NOW,
      HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    });
    const logPath = join(home, 'logs', 'sleep.log');
    const args = c.logFile ? [...c.args, '--log-file', logPath] : c.args;
    const res = spawnSync('node', [CLI, ...args], { cwd: home, env, encoding: 'utf-8' });
    const out: RunOutput = { status: res.status, stdout: normalise(res.stdout, home), stderr: normalise(res.stderr, home) };
    if (c.logFile) out.log = existsSync(logPath) ? normalise(readFileSync(logPath, 'utf8'), home) : '<missing>';
    return out;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('cli sleep golden output', () => {
  beforeAll(() => {
    template = join(mkdtempSync(join(tmpdir(), 'hippo-sleep-golden-template-')), '.hippo');
    seedLocal(template);
  });

  afterAll(() => {
    if (template) rmSync(join(template, '..'), { recursive: true, force: true });
  });

  it.each(CASES)('$name', (c) => {
    expect(run(c)).toMatchSnapshot();
  }, 60_000);
});
