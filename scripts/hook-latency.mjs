#!/usr/bin/env node
// Hook latency at 10,000 memories: the prompt hook (`context`, promptRecall off and on) and the
// failure hook (`capture-error`, a new failure and a repeat). Run after `npm run build`:
//   node scripts/hook-latency.mjs [--runs 30] [--memories 10000] [--ledger-compare [--contention]]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HIPPO_JS = path.join(REPO, 'bin', 'hippo.js');
const runsFlag = process.argv.indexOf('--runs');
const RUNS = runsFlag > 0 ? Number(process.argv[runsFlag + 1]) : 30;
const memoriesFlag = process.argv.indexOf('--memories');
const MEMORIES = memoriesFlag > 0 ? Number(process.argv[memoriesFlag + 1]) : 10000;
const LEDGER_COMPARE = process.argv.includes('--ledger-compare');
const CONTENTION = process.argv.includes('--contention');

// Windows dynamic import() needs a file:// URL, not a raw drive path.
const { createMemory } = await import(pathToFileURL(path.join(REPO, 'dist', 'core/memory.js')));
const { initStore } = await import(pathToFileURL(path.join(REPO, 'dist', 'store', 'open.js')));
const { writeEntry } = await import(pathToFileURL(path.join(REPO, 'dist', 'store', 'entry-writes.js')));

// Same seed, vocabulary and prompts as scripts/z1-latency.mjs, so the context numbers compare.
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'deploy', 'rollback', 'migration', 'postgres', 'timeout', 'kubernetes', 'cluster',
  'incident', 'latency', 'budget', 'token', 'schema', 'index', 'cache', 'retry',
  'auth', 'session', 'webhook', 'queue', 'worker', 'config', 'pipeline', 'staging',
  'release', 'canary', 'metric', 'dashboard', 'alert', 'threshold', 'replica',
];

function sentence(rng, targetChars) {
  const words = [];
  let len = 0;
  while (len < targetChars) {
    const w = WORDS[Math.floor(rng() * WORDS.length)];
    words.push(w);
    len += w.length + 1;
  }
  return `synthetic memory ${words.join(' ')}`.slice(0, targetChars + 20);
}

const SHORT_PROMPT =
  'the postgres migration rollback plan keeps timing out during the staging deploy, what changed in the last release';
const LONG_PROMPT = ('deploy rollback plan postgres migration cluster incident latency budget token schema index cache retry auth session webhook queue worker config pipeline staging release canary metric dashboard alert threshold replica '.repeat(20)).slice(0, 4200);

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// failureSignature folds digits and hex runs, so a new failure needs new letters, not a new number.
function letters(n) {
  let s = '';
  do { s += 'ghijklmnopqrstuvwxyz'[n % 20]; n = Math.floor(n / 20); } while (n > 0);
  return s;
}

function buildStore(config) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-hook-latency-'));
  const local = path.join(base, 'local', '.hippo');
  const globalRoot = path.join(base, 'global');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(globalRoot, { recursive: true });
  initStore(local);
  initStore(globalRoot);
  const rng = mulberry32(0xa1);
  for (let i = 0; i < MEMORIES; i++) writeEntry(local, createMemory(sentence(rng, 180), { source: 'hook-latency' }));
  for (let i = 0; i < 5; i++) writeEntry(local, createMemory(`PINNED: ${sentence(rng, 120)}`, { pinned: true, source: 'hook-latency' }));
  fs.writeFileSync(path.join(local, 'config.json'), JSON.stringify(config));
  return { base, local, globalRoot };
}

function run(store, args, input) {
  const t0 = performance.now();
  execFileSync(process.execPath, [HIPPO_JS, ...args], {
    env: { ...process.env, HIPPO_HOME: store.globalRoot },
    cwd: path.dirname(store.local),
    input,
    encoding: 'utf8',
  });
  return performance.now() - t0;
}

function bench(label, once) {
  for (let i = 0; i < 3; i++) once(-1 - i);
  const samples = [];
  for (let i = 0; i < RUNS; i++) samples.push(once(i));
  samples.sort((a, b) => a - b);
  const r = { p50: percentile(samples, 50), p95: percentile(samples, 95) };
  console.error(`  [${label}] p50=${r.p50.toFixed(1)}ms p95=${r.p95.toFixed(1)}ms`);
  return r;
}

const CONTEXT_ARGS = ['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'];
const contextHook = (store, prompt) => () =>
  run(store, CONTEXT_ARGS, JSON.stringify({ session_id: crypto.randomUUID(), prompt }));
const failure = (text) => JSON.stringify({
  session_id: 'hook-latency', tool_name: 'Bash', tool_input: { command: 'make build' }, error: text,
});

const WARMUPS = 3;
const LEDGER_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !['HIPPO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'HIPPO_FAKE_NOW'].includes(k)));
// Holds the write lock 30 ms at a time, so a ledger write meets a busy store.
const CONTENDER = `const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout = 5000');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (;;) { db.exec('BEGIN IMMEDIATE'); pause(30); db.exec('COMMIT'); pause(5); }`;

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Copied rather than rebuilt so both ledger arms hold byte-identical memories, ids and timestamps.
function cloneStore(seed, config) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ledger-compare-'));
  fs.cpSync(seed.base, base, { recursive: true });
  const store = { base, local: path.join(base, 'local', '.hippo'), globalRoot: path.join(base, 'global') };
  fs.writeFileSync(path.join(store.local, 'config.json'), JSON.stringify(config));
  return store;
}

function runHook(store, input) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [HIPPO_JS, ...CONTEXT_ARGS], {
    env: { ...LEDGER_ENV, HIPPO_HOME: store.globalRoot }, cwd: path.dirname(store.local), input, encoding: 'utf8',
  });
  const ms = performance.now() - t0;
  if (r.status !== 0) throw new Error(`hook exited ${r.status}: ${r.stderr}`);
  const ledgerLines = r.stderr.split('\n').filter((line) => line.includes('delivery ledger')).length;
  return { ms, stdout: r.stdout, ledgerLines };
}

function storeState(store) {
  const file = path.join(store.local, 'hippo.db');
  const db = new DatabaseSync(file);
  let rows;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    rows = { events: count('delivery_events'), candidates: count('delivery_candidates') };
  } finally {
    db.close();
  }
  const bytes = [file, `${file}-wal`].reduce((n, f) => n + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
  return { ...rows, bytes };
}

function latency(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
}

function turnInput(mode, i) {
  const session = mode === 'steady' ? 'steady' : `${mode}-${i}`;
  return JSON.stringify({ session_id: session, prompt: `${SHORT_PROMPT} ${letters(i)}`, hook_event_name: 'UserPromptSubmit' });
}

// Each turn runs both arms on the same payload, off first on even turns and on first on odd ones, so order effects cancel.
// Warm-ups count for stdout and bytes, not latency.
function measurePair(pair, mode, estimateTokens) {
  const before = [storeState(pair.off), storeState(pair.on)];
  const contenders = mode === 'contention'
    ? [pair.off, pair.on].map((s) => spawn(process.execPath, ['-e', CONTENDER, path.join(s.local, 'hippo.db')], { stdio: 'ignore' }))
    : [];
  if (contenders.length > 0) pause(300);
  const turns = WARMUPS + RUNS;
  const samples = { off: [], on: [] };
  let matches = 0;
  let tokenDelta = 0;
  let ledgerLines = 0;
  try {
    for (let i = 0; i < turns; i++) {
      const input = turnInput(mode, i);
      const offFirst = i % 2 === 0;
      const first = runHook(offFirst ? pair.off : pair.on, input);
      const second = runHook(offFirst ? pair.on : pair.off, input);
      const [off, on] = offFirst ? [first, second] : [second, first];
      if (i >= WARMUPS) { samples.off.push(off.ms); samples.on.push(on.ms); }
      if (sha(off.stdout) === sha(on.stdout)) matches++;
      tokenDelta += estimateTokens(on.stdout) - estimateTokens(off.stdout);
      ledgerLines += off.ledgerLines + on.ledgerLines;
    }
  } finally {
    for (const c of contenders) c.kill();
  }
  const after = [storeState(pair.off), storeState(pair.on)];
  const off = latency(samples.off);
  const on = latency(samples.on);
  const events = after[1].events - before[1].events;
  const cell = {
    off, on, p95_ratio: on.p95 / off.p95, p50_delta_ms: on.p50 - off.p50,
    stdout_match_share: matches / turns, token_delta: tokenDelta,
    bytes_per_turn: (after[1].bytes - before[1].bytes - (after[0].bytes - before[0].bytes)) / turns,
    delivery_rows_per_turn: (events + after[1].candidates - before[1].candidates) / turns,
    off_arm_delivery_rows: after[0].events - before[0].events + after[0].candidates - before[0].candidates,
    turns, rows_dropped: turns - events, ledger_stderr_lines: ledgerLines,
  };
  console.error(`  [${mode}] p50 ${off.p50.toFixed(1)} -> ${on.p50.toFixed(1)}ms, p95 ${off.p95.toFixed(1)} -> ${on.p95.toFixed(1)}ms, ${cell.bytes_per_turn.toFixed(0)} B/turn`);
  return cell;
}

function checkBounds(arms) {
  const all = Object.values(arms).flatMap((modes) => Object.values(modes));
  const timed = Object.values(arms).flatMap((modes) => [modes.fresh, modes.steady]);
  const bound = (cells, pick, worstOf, pass) => {
    const worst = worstOf(...cells.map(pick));
    return { worst, pass: pass(worst) };
  };
  return {
    stdout_identical: bound(all, (c) => c.stdout_match_share, Math.min, (w) => w === 1),
    token_delta_zero: bound(all, (c) => Math.abs(c.token_delta), Math.max, (w) => w === 0),
    p95_ratio_le_1_10: bound(timed, (c) => c.p95_ratio, Math.max, (w) => w <= 1.1),
    p50_delta_le_15ms: bound(timed, (c) => c.p50_delta_ms, Math.max, (w) => w <= 15),
    bytes_per_turn_le_7168: bound(timed, (c) => c.bytes_per_turn, Math.max, (w) => w <= 7168),
  };
}

async function ledgerCompare() {
  const { estimateTokens } = await import(pathToFileURL(path.join(REPO, 'dist', 'util', 'token-text.js')));
  const stores = [];
  const arms = {};
  try {
    for (const promptRecall of [false, true]) {
      const seed = buildStore({ pinnedInject: { promptRecall } });
      stores.push(seed);
      const [off, on] = [false, true].map((enabled) =>
        cloneStore(seed, { pinnedInject: { promptRecall }, deliveryLedger: { enabled } }));
      stores.push(off, on);
      console.error(`promptRecall=${promptRecall}`);
      const modes = {};
      for (const mode of CONTENTION ? ['fresh', 'steady', 'contention'] : ['fresh', 'steady']) {
        modes[mode] = measurePair({ off, on }, mode, estimateTokens);
      }
      arms[`promptRecall=${promptRecall ? 'on' : 'off'}`] = modes;
    }
  } finally {
    for (const s of stores) fs.rmSync(s.base, { recursive: true, force: true });
  }
  const bounds = checkBounds(arms);
  const pass = Object.values(bounds).every((b) => b.pass);
  console.log(JSON.stringify({ memories: MEMORIES, runs: RUNS, warmups: WARMUPS, arms, bounds, pass }, null, 2));
}

async function main() {
  if (LEDGER_COMPARE) return ledgerCompare();
  const results = {};
  for (const [label, on] of [['A1', false], ['Z1', true]]) {
    const store = buildStore({ pinnedInject: { promptRecall: on } });
    try {
      console.error(`context, promptRecall=${on}`);
      results[`context ${label} short`] = bench(`${label} short`, contextHook(store, SHORT_PROMPT));
      results[`context ${label} long`] = bench(`${label} long`, contextHook(store, LONG_PROMPT));
      if (label !== 'A1') continue;
      console.error('capture-error');
      const salt = crypto.randomUUID().replace(/[^g-z]/g, '');
      results['capture-error new'] = bench('new failure', (i) =>
        run(store, ['capture-error'], failure(`Exit code 2 make: *** no rule to make target ${salt}${letters(i + 3)}`)));
      results['capture-error repeat'] = bench('repeat', () =>
        run(store, ['capture-error'], failure('Exit code 2 make: *** no rule to make target alwaysthesame')));
    } finally {
      fs.rmSync(store.base, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
