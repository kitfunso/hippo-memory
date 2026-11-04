#!/usr/bin/env node
// Replays real session transcripts through capture in a throwaway store and prints what would pin.
// Run it before any change to a capture route: a benchmark's clean teach text cannot show precision.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const USAGE = 'usage: node scripts/capture-replay.mjs <file with one transcript path per line> [hippo.js]';
const LONG_TOKEN = /[A-Za-z0-9_-]{28,}/g;
const READ_OK = /Captured \d+ items|No actionable items found/;

function run(hippo, cwd, env, args, input) {
  const done = spawnSync(process.execPath, [hippo, ...args], { cwd, env, input, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`hippo ${args.join(' ')} exited ${done.status}: ${done.stderr.slice(0, 300)}`);
  return done.stdout;
}

function replay(transcripts, hippo, scratch) {
  const project = join(scratch, 'project');
  const home = join(scratch, 'home');
  mkdirSync(project);
  mkdirSync(home);
  const { ANTHROPIC_API_KEY: _key, ...rest } = process.env;
  const env = { ...rest, HIPPO_HOME: home, HIPPO_SKIP_SCHEDULE: '1' };
  spawnSync('git', ['init', '-q', '.'], { cwd: project });
  run(hippo, project, env, ['init', '--no-hooks', '--no-schedule', '--no-learn']);
  for (const transcript of transcripts) {
    const out = run(hippo, project, env, ['capture', '--transcript', transcript]);
    if (!READ_OK.test(out)) throw new Error(`hippo read no session from ${transcript}: ${out.slice(0, 200)}`);
  }
  const printed = run(hippo, project, env, ['session-rules'], '{"session_id":"capture-replay"}');
  if (printed.trim() === '') return [];
  const text = JSON.parse(printed).hookSpecificOutput.additionalContext;
  return text
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
}

const [list, hippoArg = 'bin/hippo.js'] = process.argv.slice(2);
if (list === undefined) {
  console.error(USAGE);
  process.exit(2);
}
const hippo = resolve(hippoArg);
const transcripts = readFileSync(list, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((path) => resolve(path));
const missing = transcripts.find((path) => !existsSync(path));
if (missing !== undefined) {
  console.error(`no transcript at ${missing}: fix the list in ${list}`);
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), 'capture-replay-'));
try {
  const rules = replay(transcripts, hippo, scratch);
  for (const rule of rules) console.log(JSON.stringify({ rule: rule.replace(LONG_TOKEN, '[masked]').slice(0, 300) }));
  console.log(JSON.stringify({ sessions: transcripts.length, pinned: rules.length }));
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
