// Pins stdout, stderr and the exit status of failing `hippo` invocations across the verb files, on the built CLI
// and a real store, so a change to how a verb stops its command cannot move a byte or a code.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { initStore } from '../src/store/open.js';
import { hippoRun } from './_helpers/spawn-hippo.js';

// Forward slashes, since NODE_OPTIONS reads a backslash as an escape.
const FETCH_UNAUTHORISED = resolve(__dirname, '_helpers', 'fetch-unauthorised.cjs').split(sep).join('/');
const FAILING_COMMAND = 'node -e "process.exit(3)"';
const SPAWN_TIMEOUT_MS = 60_000;

interface Case {
  readonly name: string;
  readonly args: readonly string[];
  /** `store` is a folder with an initialised store, `bare` one with none. */
  readonly cwd: 'store' | 'bare';
  readonly env?: Readonly<Record<string, string>>;
}

const inStore = (name: string, ...args: string[]): Case => ({ name, args, cwd: 'store' });
const inBare = (name: string, ...args: string[]): Case => ({ name, args, cwd: 'bare' });

const CASES: readonly Case[] = [
  inBare('version', '--version'),
  inBare('unknown verb', 'nosuchverb'),
  inStore('unknown flag on a destructive verb', 'forget', 'mem_x', '--bogus'),
  inStore('dry-run on a verb without one', 'remember', 'three short words', '--dry-run'),
  inStore('context with a negative budget', 'context', '--budget', '-5'),
  inStore('list with a zero limit', 'process', 'list', '--limit', '0'),
  inStore('github backfill without a repo', 'github', 'backfill'),
  inStore('github backfill without a token', 'github', 'backfill', '--repo', 'acme/widgets'),
  {
    name: 'github backfill refused by the server',
    args: ['github', 'backfill', '--repo', 'acme/widgets'],
    cwd: 'store',
    env: { GITHUB_TOKEN: 'not-a-real-token', NODE_OPTIONS: `--require "${FETCH_UNAUTHORISED}"` },
  },
  inStore('github without a subcommand', 'github'),
  inStore('remember too short', 'remember', 'ab'),
  inStore('recall without a query', 'recall'),
  inStore('recall with an unknown outcome', 'recall', 'deploy keys', '--outcome', 'bogus'),
  inStore('drill past the depth range', 'drill', '1', '--depth', '99'),
  inStore('assemble without a session', 'assemble'),
  inStore('explain without a query', 'explain'),
  inStore('eval with a missing corpus', 'eval', 'no-such-corpus.json'),
  inStore('refine without a key', 'refine'),
  inStore('capture without a source', 'capture'),
  inBare('compact-resume with no store', 'compact-resume'),
  inStore('compact-resume with an empty store', 'compact-resume'),
  inStore('auth revoke of an unknown key', 'auth', 'revoke', 'hk_nosuchkey'),
  inStore('goal without a subcommand', 'goal'),
  inStore('slack backfill without a channel', 'slack', 'backfill'),
  inStore('slack backfill without a token', 'slack', 'backfill', '--channel', 'C123'),
  inStore('audit list with an unknown op', 'audit', 'list', '--op', 'bogus'),
  inStore('inspect without an id', 'inspect'),
  inStore('forget without an id', 'forget'),
  inStore('snapshot save without a task', 'snapshot', 'save'),
  inStore('card show of a missing card', 'card', 'show', '999'),
  inStore('list with an unknown status', 'process', 'list', '--status', 'bogus'),
  inStore('decide get of a missing decision', 'decide', 'get', '999'),
  inStore('predict baserate without a class', 'predict', 'baserate'),
  inStore('hook install of an unknown target', 'hook', 'install', 'bogus'),
  inStore('watch without a command', 'watch'),
  inBare('watch of a failing command with no store', 'watch', FAILING_COMMAND),
  inStore('watch of a failing command', 'watch', FAILING_COMMAND),
  inStore('serve with one TLS file', 'serve', '--tls-cert', 'cert.pem'),
  inStore('policy asof without a date', 'policy', 'asof'),
  inStore('brief refresh without a repo', 'brief', 'refresh'),
];

const DROPPED_ENV = ['GITHUB_TOKEN', 'SLACK_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'HIPPO_API_KEY', 'HIPPO_LOG_LEVEL', 'HIPPO_TENANT', 'HIPPO_SESSION_ID'];

let store = '';
let bare = '';
let home = '';
let usage = '';
const codes = new Set<number | null>();

beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), 'hippo-exit-parity-store-'));
  mkdirSync(join(store, '.hippo'));
  initStore(join(store, '.hippo'));
  bare = mkdtempSync(join(tmpdir(), 'hippo-exit-parity-bare-'));
  home = mkdtempSync(join(tmpdir(), 'hippo-exit-parity-home-'));
  usage = hippoRun(['help'], { cwd: bare, env: childEnv(), timeout: SPAWN_TIMEOUT_MS }).stdout;
});

afterAll(() => {
  for (const dir of [store, bare, home]) rmSync(dir, { recursive: true, force: true });
});

function childEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: home, HIPPO_SKIP_AUTO_INTEGRATIONS: '1', NO_COLOR: '1', NODE_NO_WARNINGS: '1' };
  for (const key of DROPPED_ENV) delete env[key];
  return { ...env, ...extra };
}

/** Folder names differ per run and per platform, so each one prints as its label with forward slashes. */
function masked(text: string): string {
  // The version line moves with every release.
  let out = text.replace(/\r\n/g, '\n').replaceAll('\\', '/').replace(/^\d+\.\d+\.\d+\n$/, '<version>\n');
  const labels: ReadonlyArray<readonly [string, string]> = [[store, '<store>'], [bare, '<bare>'], [home, '<home>']];
  for (const [dir, label] of labels) {
    for (const form of new Set([dir, realpathSync.native(dir), realpathSync(dir)])) out = out.replaceAll(form.replaceAll('\\', '/'), label);
  }
  return out;
}

function run(c: Case) {
  const r = hippoRun(c.args, { cwd: c.cwd === 'store' ? store : bare, env: childEnv(c.env), input: '', timeout: SPAWN_TIMEOUT_MS });
  codes.add(r.status);
  // The usage text grows with every verb; `hippo help` prints it, so only its presence is pinned here.
  const stdout = usage.length > 0 ? r.stdout.replace(usage, '<the text of hippo help>\n') : r.stdout;
  return { stdout: masked(stdout), stderr: masked(r.stderr), status: r.status };
}

describe('hippo exit codes and output of failing invocations (built CLI)', () => {
  it.each(CASES)('$name', (c) => {
    const r = run(c);
    expect(`$ hippo ${c.args.join(' ')} -> ${r.status}\n--- stdout\n${r.stdout}--- stderr\n${r.stderr}`).toMatchSnapshot();
  }, SPAWN_TIMEOUT_MS * 2);

  // Reads what the cases above recorded, so it holds only on a whole-file run.
  it('covers every exit code a verb hands to the entry', () => {
    expect([...codes].sort()).toEqual([0, 1, 2, 3]);
  });
});
