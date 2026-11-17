// HIPPO_READ_ONLY=1 on a real store: each read surface answers as it does without the switch and leaves every file
// byte as it was, every MCP write tool refuses, and session-end starts no worker.
import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import { READ_ONLY_REFUSAL } from '../../src/base/errors/read-only.js';
import { WRITE_TOOLS } from '../../src/surface/mcp/tools.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { makeRoot, makeStore, type MadeStore } from '../_helpers/make-root.js';
import { hippoOut, hippoRun } from '../_helpers/spawn-hippo.js';

const SEEDS = [
  ['the staging queue drains at midnight'],
  ['always run the migration check before deploy', '--pin'],
  ['berlin office moved in march'],
  ['the deploy failed because the queue was full', '--error'],
];

// One valid call per tool the server lists, so a tool answers an error only when it refuses.
const TOOL_ARGS = {
  hippo_recall: { query: 'queue' },
  hippo_assemble: { session_id: 's1' },
  hippo_drill: { summary_id: 'mem_none' },
  hippo_remember: { text: 'a write the switch refuses' },
  hippo_outcome: { good: true },
  hippo_context: {},
  hippo_status: {},
  hippo_learn: {},
  hippo_conflicts: {},
  hippo_resolve: { conflict_id: 1, keep: 'mem_none' },
  hippo_share: { id: 'mem_none' },
  hippo_peers: {},
  hippo_predict_baserate: { class_tag: 'deploy' },
} satisfies Record<string, Record<string, JsonValue>>;

// A writer that exits without closing, so its frames stay in hippo.db-wal as a crashed or live writer leaves them.
const WAL_FRAME = [
  "const { DatabaseSync } = require('node:sqlite');",
  'const db = new DatabaseSync(process.argv[1]);',
  "db.exec('PRAGMA wal_autocheckpoint = 0');",
  "db.prepare(\"INSERT OR REPLACE INTO meta (key, value) VALUES ('read_only_test', ?)\").run(process.argv[2]);",
  'process.exit(0);',
].join('\n');

// Records each spawn and starts nothing, so the control run's worker never touches the store.
const STUB_SPAWN = [
  "const fs = require('node:fs');",
  "const cp = require('node:child_process');",
  "const { EventEmitter } = require('node:events');",
  'cp.spawn = function (cmd, args) {',
  "  fs.appendFileSync(process.env.RECORD_SPAWN_FILE, JSON.stringify(args) + '\\n');",
  '  return Object.assign(new EventEmitter(), { unref() {} });',
  '};',
  "require('node:module').syncBuiltinESMExports();",
].join('\n');

interface Reply {
  readonly id: number;
  readonly result?: {
    readonly isError?: boolean;
    readonly content?: ReadonlyArray<{ readonly text: string }>;
    readonly tools?: ReadonlyArray<{ readonly name: string }>;
  };
  readonly error?: { readonly message: string };
}

let s: MadeStore;
let tools: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  s = makeStore('read-only');
  tools = makeRoot('read-only-tools', { init: false });
  const home = join(s.base, 'home');
  fs.mkdirSync(home);
  env = {
    ...process.env,
    HIPPO_HOME: join(s.base, 'global'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    HIPPO_FAKE_NOW: '2026-11-20T00:00:00.000Z',
    HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
    HIPPO_READ_ONLY: '0',
  };
  for (const seed of SEEDS) hippoOut(['remember', ...seed], { cwd: s.base, env });
});

const readOnly = (on: boolean): NodeJS.ProcessEnv => ({ ...env, HIPPO_READ_ONLY: on ? '1' : '0' });

/** Every file under the project folder (store, mirrors, home and global folder) by hash; -shm is SQLite's shared
 * lock memory, which every reader maps. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (!entry.name.endsWith('-shm')) {
        out.set(relative(s.base, file), createHash('sha1').update(fs.readFileSync(file)).digest('hex'));
      }
    }
  };
  walk(s.base);
  return out;
}

const walFile = (): string => join(s.root, 'hippo.db-wal');

function leaveWalFrame(tag: string): void {
  const r = spawnSync(process.execPath, ['-e', WAL_FRAME, join(s.root, 'hippo.db'), tag], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  expect(fs.statSync(walFile()).size).toBeGreaterThan(0);
}

function frames(calls: ReadonlyArray<readonly [string, Record<string, JsonValue>]>): string {
  const lines = calls.map(([name, args], i) =>
    JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: args } }),
  );
  return `${[JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }), ...lines].join('\n')}\n`;
}

/** The server's replies in request order: it answers calls as each one finishes. */
function replies(stdout: string): Reply[] {
  const lines = stdout.trim().split('\n');
  // SAFETY: hippo mcp writes one JSON-RPC reply per line, each with the id of its request.
  const all = lines.map((line) => JSON.parse(line) as Reply);
  return all.sort((a, b) => a.id - b.id);
}

interface Surface {
  readonly name: string;
  readonly args: readonly string[];
  readonly input?: (tag: string) => string;
  /** What a real answer holds, so two empty outputs never pass as the same. */
  readonly shows: string;
}

const MCP_READS: ReadonlyArray<readonly [string, Record<string, JsonValue>]> = [
  ['hippo_recall', { query: 'queue' }],
  ['hippo_context', {}],
  ['hippo_assemble', { session_id: 's1' }],
];

const SURFACES: readonly Surface[] = [
  { name: 'hippo recall', args: ['recall', 'queue deploy'], shows: 'staging queue' },
  { name: 'hippo context', args: ['context', '--auto', '--budget', '1500'], shows: 'migration check' },
  {
    name: 'the UserPromptSubmit hook',
    args: ['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'],
    // A session of its own per run, since the run without the switch books what it sent and the next one skips it.
    input: (tag) => JSON.stringify({ session_id: `read-only-${tag}`, prompt: 'what about the queue' }),
    shows: 'additionalContext',
  },
  { name: 'MCP hippo_recall, hippo_context and hippo_assemble', args: ['mcp'], input: () => frames(MCP_READS), shows: 'Found' },
];

const CASES = SURFACES.flatMap((surface, i) =>
  (['clean', 'mid-WAL'] as const).map((state) => ({ surface, state, name: surface.name, tag: `${i}-${state}` })),
);

describe('HIPPO_READ_ONLY=1 read surfaces', () => {
  it.each(CASES)('$name on a $state store answers as without it and changes no byte', ({ surface, state, tag }) => {
    if (state === 'mid-WAL') leaveWalFrame(tag);
    else expect(fs.existsSync(walFile())).toBe(false);
    const input = surface.input?.(tag);
    const before = snapshot();
    const on = hippoRun(surface.args, { cwd: s.base, env: readOnly(true), input });
    expect(snapshot()).toEqual(before);
    const off = hippoRun(surface.args, { cwd: s.base, env: readOnly(false), input });
    expect(on.status, on.stderr).toBe(0);
    expect(off.status, off.stderr).toBe(0);
    expect(on.stdout).toContain(surface.shows);
    if (surface.args[0] === 'mcp') {
      expect(replies(on.stdout).every((r) => r.error === undefined && r.result?.isError !== true)).toBe(true);
      expect(replies(on.stdout)).toEqual(replies(off.stdout));
    } else {
      expect(on.stdout).toBe(off.stdout);
    }
  });
});

describe('HIPPO_READ_ONLY=1 MCP tools', () => {
  it('refuses exactly the write tools and answers every other tool, changing no byte', () => {
    const calls = Object.entries(TOOL_ARGS);
    const before = snapshot();
    const run = hippoRun(['mcp'], { cwd: s.base, env: readOnly(true), input: frames(calls) });
    expect(snapshot()).toEqual(before);
    expect(run.status, run.stderr).toBe(0);
    const [list, ...answers] = replies(run.stdout);
    expect(list.result?.tools?.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_ARGS).sort());
    expect(answers.map((r) => r.error)).toEqual(calls.map(() => undefined));
    const refusing = answers.filter((r) => r.result?.isError === true).map((r) => calls[r.id - 1][0]);
    expect(refusing.sort()).toEqual(['hippo_learn', 'hippo_outcome', 'hippo_remember', 'hippo_resolve', 'hippo_share']);
    expect(refusing).toEqual([...WRITE_TOOLS].sort());
    for (const r of answers.filter((a) => a.result?.isError === true)) {
      expect(r.result?.content?.[0]?.text).toBe(READ_ONLY_REFUSAL);
    }
  });
});

describe('HIPPO_READ_ONLY=1 session-end', () => {
  it('starts no worker under the switch, where the same run without it starts one', () => {
    const stub = join(tools, 'stub-spawn.cjs');
    fs.writeFileSync(stub, `${STUB_SPAWN}\n`);
    const spawnsOf = (on: boolean): string[] => {
      const record = join(tools, `spawns-${on ? 'on' : 'off'}.jsonl`);
      // Forward slashes, since NODE_OPTIONS reads a backslash as an escape.
      const nodeOptions = `${env.NODE_OPTIONS ?? ''} --require "${stub.split('\\').join('/')}"`;
      const run = hippoRun(['session-end'], {
        cwd: s.base,
        env: { ...readOnly(on), RECORD_SPAWN_FILE: record, NODE_OPTIONS: nodeOptions },
        input: JSON.stringify({ session_id: 'read-only-end' }),
      });
      expect(run.status, run.stderr).toBe(0);
      if (on) expect(run.stderr).toContain('hippo session-end: skipped under HIPPO_READ_ONLY=1');
      return fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n') : [];
    };
    const before = snapshot();
    expect(spawnsOf(true)).toEqual([]);
    expect(snapshot()).toEqual(before);
    const control = spawnsOf(false);
    expect(control).toHaveLength(1);
    expect(control[0]).toContain('__session-end-worker');
  });
});
