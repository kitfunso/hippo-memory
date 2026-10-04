// Pins the exact stdout, stderr and exit code of every help and unknown-verb form of the built CLI, so a
// refactor of main()'s dispatch or of the usage text that changes a byte fails here.

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'bin', 'hippo.js');
// Explicit, so a verb dropped from dispatch fails here rather than leaving the list quietly.
const VERBS = [
  'init', 'remember', 'recall', 'drill', 'assemble', 'supersede', 'explain', 'eval', 'trace', 'refine', 'sleep',
  'last-sleep', 'session-end', '__session-end-worker', 'pre-compact', 'post-compact', 'capture-error',
  'compact-resume', 'codex-run', '__codex-session-end-worker', 'dedup', 'dag', 'auth', 'goal', 'slack', 'github',
  'audit', 'correction-latency', 'provenance', 'status', 'outcome', 'conflicts', 'resolve', 'reject', 'rejections',
  'unreject', 'dormant', 'projects', 'quarantine', 'tokens', 'failures', 'doctor', 'support-bundle', 'snapshot',
  'session', 'handoff', 'card', 'predict', 'current', 'forget', 'inspect', 'context', 'hook', 'setup',
  'daily-runner', 'embed', 'watch', 'learn', 'promote', 'sync', 'share', 'peers', 'import', 'export', 'capture',
  'dashboard', 'wm', 'mcp', 'serve', 'invalidate', 'decide', 'incident', 'process', 'policy', 'skill', 'brief',
  'project-brief', 'note', 'customer-note', 'graph',
];
// Whether Node prints the SQLite warning depends on its version, so it stays out of the snapshot.
const SQLITE_WARNING = /\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature[^\n]*\r?\n\(Use `node --trace-warnings[^\n]*(?:\r?\n)?/g;
// No PATH, so a verb that ignored --help could not reach schtasks, crontab or codex.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));

interface RunOutput { status: number | null; stdout: string; stderr: string }

function run(args: string[]): Promise<RunOutput> {
  const home = mkdtempSync(join(tmpdir(), 'hippo-help-golden-'));
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: home,
    env: { ...ENV, HOME: home, USERPROFILE: home, HIPPO_HOME: join(home, 'global'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => {
      rmSync(home, { recursive: true, force: true });
      resolve({ status, stdout, stderr: stderr.replace(SQLITE_WARNING, '') });
    });
  });
}

const fullUsage = run(['--help']);

// The full listing is pinned once, under hippo --help; every other snapshot names it instead of repeating it.
async function pinned(args: string[]): Promise<RunOutput> {
  const [out, full] = await Promise.all([run(args), fullUsage]);
  return out.stdout === full.stdout ? { ...out, stdout: '<full usage>' } : out;
}

describe('built CLI help output is byte-identical', () => {
  it('hippo --help', async () => {
    expect(await fullUsage).toMatchSnapshot();
  });

  it.concurrent.for([{ args: [] }, { args: ['-h'] }, { args: ['help'] }])(
    'hippo $args prints the same full usage',
    async ({ args }, { expect: local }) => {
      local(await run(args)).toEqual(await fullUsage);
    },
  );

  it.concurrent.for(VERBS)('hippo help %s prints the full usage', async (verb, { expect: local }) => {
    local(await run(['help', verb])).toEqual(await fullUsage);
  });

  it.concurrent.for(VERBS)('hippo %s --help', async (verb, { expect: local }) => {
    local(await pinned([verb, '--help'])).toMatchSnapshot();
  });

  it.concurrent.for([['audit', 'prune'], ['slack', 'backfill'], ['slack', 'workspaces'], ['github', 'backfill']])(
    'hippo %s %s --help',
    async ([verb, sub], { expect: local }) => {
      local(await pinned([verb, sub, '--help'])).toMatchSnapshot();
    },
  );

  it.concurrent.for([{ args: ['frobnicate'] }, { args: ['frobnicate', '--help'] }, { args: ['frobnicate', '--zzz'] }])(
    'unknown verb: hippo $args',
    async ({ args }, { expect: local }) => {
      local(await pinned(args)).toMatchSnapshot();
    },
  );

  it('hippo --version prints the package version', async () => {
    // SAFETY: package.json always carries a string version.
    const { version } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    expect(await run(['--version'])).toEqual({ status: 0, stdout: `${version}\n`, stderr: '' });
  });
});
