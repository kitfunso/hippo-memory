#!/usr/bin/env node
// The delivery ledger's own time per prompt-hook turn, measured inside one process, so Node start-up noise
// cannot swamp a cost of a few ms. Run after `npm run build`:
//   node scripts/ledger-overhead.mjs [--runs 200] [--memories 2000]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mulberry32 } from './lib/prng.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const RUNS = flag('--runs', 200);
const MEMORIES = flag('--memories', 2000);
const WARMUPS = 10;
const P50_BOUND_MS = 15;
const P95_BOUND_MS = 30;

const load = (file) => import(pathToFileURL(path.join(REPO, 'dist', file)));
const { createMemory } = await load('core/memory.js');
const { initStore } = await load('store/open.js');
const { writeEntry } = await load('store/entry-writes.js');
const api = await load('api/index.js');
const { contextCost } = await load('api/context-render.js');
const { createDeliveryRecorder } = await load('store/delivery-recorder.js');
const { writeDeliveryEventOnHandle } = await load('store/recall-trace.js');
const { openHippoDb, closeHippoDb } = await load('db/index.js');
const { blockHash } = await load('util/token-text.js');
const { recordTokenUse } = await load('store/token-ledger.js');

// Same seed, vocabulary and prompt as scripts/hook-latency.mjs, so the stores match.
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
const PROMPT =
  'the postgres migration rollback plan keeps timing out during the staging deploy, what changed in the last release';

function buildStore(config) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ledger-overhead-'));
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

// Holds the write lock 30 ms at a time, as in scripts/hook-latency.mjs.
const CONTENDER = `const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout = 5000');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (;;) { db.exec('BEGIN IMMEDIATE'); pause(30); db.exec('COMMIT'); pause(5); }`;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Times every observer call; watchAdmit's wrapper is charged only for its own time, not the admit it wraps.
function timedObserver(rec, acc) {
  const wrap = (name) => (...args) => {
    const t0 = performance.now();
    try { return rec[name](...args); } finally { acc.ms += performance.now() - t0; }
  };
  const names = ['facts', 'sections', 'qualityDropped', 'disabled', 'offer', 'reject', 'dropMissing', 'gated', 'selected'];
  const obs = Object.fromEntries(names.map((n) => [n, wrap(n)]));
  obs.watchAdmit = (admit) => {
    let inner = 0;
    const t0 = performance.now();
    const wrapped = rec.watchAdmit((e) => {
      const s = performance.now();
      try { return admit(e); } finally { inner += performance.now() - s; }
    });
    acc.ms += performance.now() - t0;
    return (e) => {
      const s = performance.now();
      const before = inner;
      try { return wrapped(e); } finally { acc.ms += performance.now() - s - (inner - before); }
    };
  };
  return obs;
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: percentile(s, 50), p95: percentile(s, 95), max: s[s.length - 1] };
};

async function turn(store, mode, i) {
  const sessionId = mode === 'steady' ? 'steady' : `${mode}-${i}`;
  const stdinText = JSON.stringify({ session_id: sessionId, prompt: `${PROMPT} ${i}`, hook_event_name: 'UserPromptSubmit' });
  const ctx = { hippoRoot: store.local, tenantId: 'default', actor: api.adminActor('cli') };
  const opts = {
    q: '', budget: 1500, pinnedOnly: true, includeRecent: 5, currentSessionId: sessionId,
    prompt: `${PROMPT} ${i}`, cost: contextCost('additional-context', 'observe'),
  };

  const t0 = performance.now();
  const rec = createDeliveryRecorder({
    root: store.local, storeHash: blockHash(path.resolve(store.local)), writeStore: 'local',
    tenantId: 'default', stdinText, envSessionId: undefined,
  });
  const createMs = performance.now() - t0;

  const acc = { ms: 0 };
  const g0 = performance.now();
  const result = await api.getContext(ctx, { ...opts, deliveryObserver: timedObserver(rec, acc) });
  const contextMs = performance.now() - g0 - acc.ms;

  const emitted = result.entries.map((r) => r.entry.content).join('\n');
  const d0 = performance.now();
  rec.delivered(emitted.length > 0 ? { state: 'sent', emittedText: `${emitted}\n` } : { state: 'empty' });
  const deliveredMs = performance.now() - d0;

  // The token ledger's handle and its inject row exist with or without the ledger, so neither is charged; the
  // event follows that row on the same handle, as in the CLI.
  const db = openHippoDb(store.local);
  let flushMs;
  let written = false;
  try {
    recordTokenUse(db, { tenantId: 'default', sessionId, surface: 'hook', event: 'inject', items: result.entries.length, tokens: 0 });
    const f0 = performance.now();
    rec.flush((input) => {
      const id = writeDeliveryEventOnHandle(db, input);
      written = id !== null;
      return id;
    });
    flushMs = performance.now() - f0;
  } finally {
    closeHippoDb(db);
  }
  return { ledgerMs: createMs + acc.ms + deliveredMs + flushMs, observerMs: acc.ms, flushMs, contextMs, written };
}

async function cell(store, mode) {
  const contender = mode === 'contention'
    ? spawn(process.execPath, ['-e', CONTENDER, path.join(store.local, 'hippo.db')], { stdio: 'ignore' })
    : null;
  if (contender) pause(300);
  const rows = [];
  try {
    for (let i = 0; i < WARMUPS + RUNS; i++) {
      const r = await turn(store, mode, i);
      if (i >= WARMUPS) rows.push(r);
    }
  } finally {
    contender?.kill();
  }
  const out = {
    ledger: stats(rows.map((r) => r.ledgerMs)),
    observer: stats(rows.map((r) => r.observerMs)),
    flush: stats(rows.map((r) => r.flushMs)),
    context_without_ledger: stats(rows.map((r) => r.contextMs)),
    dropped: rows.filter((r) => !r.written).length,
    turns: rows.length,
  };
  console.error(`  [${mode}] ledger p50 ${out.ledger.p50.toFixed(2)} p95 ${out.ledger.p95.toFixed(2)} max ${out.ledger.max.toFixed(1)} ms, flush p95 ${out.flush.p95.toFixed(2)}, dropped ${out.dropped}/${out.turns}`);
  return out;
}

async function main() {
  const arms = {};
  const stores = [];
  const priorHome = process.env.HIPPO_HOME;
  try {
    for (const promptRecall of [false, true]) {
      const store = buildStore({ pinnedInject: { promptRecall }, deliveryLedger: { enabled: true } });
      stores.push(store);
      process.env.HIPPO_HOME = store.globalRoot;
      console.error(`promptRecall=${promptRecall}`);
      const modes = {};
      for (const mode of ['fresh', 'steady', 'contention']) modes[mode] = await cell(store, mode);
      arms[`promptRecall=${promptRecall ? 'on' : 'off'}`] = modes;
    }
  } finally {
    if (priorHome === undefined) delete process.env.HIPPO_HOME; else process.env.HIPPO_HOME = priorHome;
    for (const s of stores) fs.rmSync(s.base, { recursive: true, force: true });
  }
  const timed = Object.values(arms).flatMap((m) => [m.fresh, m.steady]);
  const worstP50 = Math.max(...timed.map((c) => c.ledger.p50));
  const worstP95 = Math.max(...timed.map((c) => c.ledger.p95));
  const bounds = {
    ledger_p50_le_15ms: { worst: worstP50, pass: worstP50 <= P50_BOUND_MS },
    ledger_p95_le_30ms: { worst: worstP95, pass: worstP95 <= P95_BOUND_MS },
  };
  const pass = Object.values(bounds).every((b) => b.pass);
  console.log(JSON.stringify({ memories: MEMORIES, runs: RUNS, warmups: WARMUPS, arms, bounds, pass }, null, 2));
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
