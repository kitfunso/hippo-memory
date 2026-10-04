#!/usr/bin/env node
// Z1 latency bench (docs/evals/2026-09-26-z1-prompt-recall-prereg.md, "Latency (locked)").
// Run: node scripts/z1-latency.mjs
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HIPPO_JS = path.join(REPO, 'bin', 'hippo.js');

// Windows dynamic import() needs a file:// URL, not a raw drive path.
const { createMemory } = await import(pathToFileURL(path.join(REPO, 'dist', 'memory.js')));
const { initStore } = await import(pathToFileURL(path.join(REPO, 'dist', 'store', 'open.js')));
const { writeEntry } = await import(pathToFileURL(path.join(REPO, 'dist', 'store', 'entry-writes.js')));

// Same PRNG as scripts/lifecycle-stress/inject.mjs; Math.random is banned so the corpus is reproducible.
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

function seedStore(root, rng, count) {
  for (let i = 0; i < count; i++) {
    const e = createMemory(sentence(rng, 180), { source: 'z1-latency' });
    writeEntry(root, e);
  }
  for (let i = 0; i < 5; i++) {
    const e = createMemory(`PINNED: ${sentence(rng, 120)}`, { pinned: true, source: 'z1-latency' });
    writeEntry(root, e);
  }
}

const SHORT_PROMPT =
  'the postgres migration rollback plan keeps timing out during the staging deploy, what changed in the last release';
const LONG_PROMPT = ('deploy rollback plan postgres migration cluster incident latency budget token schema index cache retry auth session webhook queue worker config pipeline staging release canary metric dashboard alert threshold replica '.repeat(20)).slice(0, 4200);

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function runOnce(hippoRoot, globalRoot, prompt) {
  const payload = JSON.stringify({ session_id: crypto.randomUUID(), prompt });
  const t0 = performance.now();
  execFileSync(process.execPath, [
    HIPPO_JS, 'context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context',
  ], {
    env: { ...process.env, HIPPO_HOME: globalRoot },
    cwd: path.dirname(hippoRoot),
    input: payload,
    encoding: 'utf8',
  });
  return performance.now() - t0;
}

function bench(hippoRoot, globalRoot, prompt, label) {
  for (let i = 0; i < 3; i++) runOnce(hippoRoot, globalRoot, prompt);
  const samples = [];
  for (let i = 0; i < 30; i++) samples.push(runOnce(hippoRoot, globalRoot, prompt));
  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  console.error(`  [${label}] p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);
  return { p50, p95 };
}

function buildArm(promptRecallOn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-z1-latency-'));
  const local = path.join(base, 'local', '.hippo');
  const globalRoot = path.join(base, 'global');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(globalRoot, { recursive: true });
  initStore(local);
  initStore(globalRoot);
  const rng = mulberry32(0xa1);
  seedStore(local, rng, 10000);
  fs.writeFileSync(path.join(local, 'config.json'), JSON.stringify({
    pinnedInject: { promptRecall: promptRecallOn },
  }));
  return { base, local, globalRoot };
}

async function main() {
  const results = {};
  for (const [armLabel, promptRecallOn] of [['A1', false], ['Z1', true]]) {
    const arm = buildArm(promptRecallOn);
    try {
      console.error(`Arm ${armLabel} (promptRecall=${promptRecallOn})`);
      results[armLabel] = {
        short: bench(arm.local, arm.globalRoot, SHORT_PROMPT, `${armLabel} short`),
        long: bench(arm.local, arm.globalRoot, LONG_PROMPT, `${armLabel} long`),
      };
    } finally {
      fs.rmSync(arm.base, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
