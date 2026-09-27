#!/usr/bin/env node
// Hook latency at 10,000 memories: the prompt hook (`context`, promptRecall off and on) and the
// failure hook (`capture-error`, a new failure and a repeat). Run after `npm run build`:
//   node scripts/hook-latency.mjs [--runs 30]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HIPPO_JS = path.join(REPO, 'bin', 'hippo.js');
const runsFlag = process.argv.indexOf('--runs');
const RUNS = runsFlag > 0 ? Number(process.argv[runsFlag + 1]) : 30;

// Windows dynamic import() needs a file:// URL, not a raw drive path.
const { createMemory } = await import(pathToFileURL(path.join(REPO, 'dist', 'memory.js')));
const { initStore, writeEntry } = await import(pathToFileURL(path.join(REPO, 'dist', 'store.js')));

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

function buildStore(promptRecallOn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-hook-latency-'));
  const local = path.join(base, 'local', '.hippo');
  const globalRoot = path.join(base, 'global');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(globalRoot, { recursive: true });
  initStore(local);
  initStore(globalRoot);
  const rng = mulberry32(0xa1);
  for (let i = 0; i < 10000; i++) writeEntry(local, createMemory(sentence(rng, 180), { source: 'hook-latency' }));
  for (let i = 0; i < 5; i++) writeEntry(local, createMemory(`PINNED: ${sentence(rng, 120)}`, { pinned: true, source: 'hook-latency' }));
  fs.writeFileSync(path.join(local, 'config.json'), JSON.stringify({ pinnedInject: { promptRecall: promptRecallOn } }));
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

async function main() {
  const results = {};
  for (const [label, on] of [['A1', false], ['Z1', true]]) {
    const store = buildStore(on);
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
