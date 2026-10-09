// How long each of sleep's graph-write transactions holds the write lock, on 4,000 decisions and 1,000 policies under the OS temp folder.
// Run by hand after `npm run build`, never in CI: node benchmarks/graph-chunk-hold.mjs [memories]. Exits 1 when a chunk holds over 150 ms.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../dist/core/memory.js';
import { initStore } from '../dist/store/open.js';
import { upsertEntryRow } from '../dist/store/entry-row.js';
import { openHippoDb, closeHippoDb } from '../dist/db/index.js';
import { saveDecision } from '../dist/objects/decisions.js';
import { savePolicy } from '../dist/objects/policies.js';
import { extractGraphChunked } from '../dist/graph/extract.js';

const LIMIT_MS = 150;
const TENANT = 'default';
const POLICIES = 1_000;
const DECISIONS = 4_000;
const MEMORIES = Number(process.argv[2] ?? 20_000);

/** Each decision names two policies, so the graph gets about two references per decision on top of its entities. */
function seedObjects(root) {
  for (let p = 0; p < POLICIES; p++) savePolicy(root, TENANT, { policyName: `RetryRule${p}`, policyText: `retry budget ${p}` });
  for (let d = 0; d < DECISIONS; d++) {
    saveDecision(root, TENANT, { decisionText: `Call ${d} applies RetryRule${d % POLICIES} and RetryRule${(d * 7 + 3) % POLICIES}` });
  }
}

/** Filler memories so the store holds `MEMORIES` rows in all, mirrors included. */
function seedFiller(root, n) {
  const db = openHippoDb(root);
  try {
    db.exec('BEGIN');
    for (let i = 0; i < n; i++) upsertEntryRow(db, createMemory(`n${i}alpha n${i}beta n${i}gamma`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    db.exec('COMMIT');
  } finally {
    closeHippoDb(db);
  }
}

function memoryCount(root) {
  const db = openHippoDb(root);
  try {
    return db.prepare('SELECT COUNT(*) AS c FROM memories').get().c;
  } finally {
    closeHippoDb(db);
  }
}

/** Records BEGIN IMMEDIATE to COMMIT for every transaction the graph writer opens, and nothing else's. */
function timeGraphChunks() {
  const holds = [];
  const begunAt = new WeakMap();
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    const graphBegin = sql === 'BEGIN IMMEDIATE' && (new Error().stack ?? '').includes('runGraphRebuildTransaction');
    const result = exec.call(this, sql);
    if (graphBegin) begunAt.set(this, performance.now());
    if (sql === 'COMMIT' && begunAt.has(this)) {
      holds.push(performance.now() - begunAt.get(this));
      begunAt.delete(this);
    }
    return result;
  };
  return { holds, restore: () => { DatabaseSync.prototype.exec = exec; } };
}

async function measure(label, root) {
  const timer = timeGraphChunks();
  const started = performance.now();
  let result;
  try {
    result = await extractGraphChunked(root, TENANT);
  } finally {
    timer.restore();
  }
  const wall = performance.now() - started;
  const sorted = [...timer.holds].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const total = sorted.reduce((s, x) => s + x, 0);
  console.log(`${label}: ${result.entities} entities, ${result.relations} relations, ${result.skipped ?? 0} skipped`);
  console.log(`  chunks ${sorted.length}  max ${at(1).toFixed(1)} ms  median ${at(0.5).toFixed(1)} ms  p95 ${at(0.95).toFixed(1)} ms`);
  console.log(`  locked ${(total / 1000).toFixed(2)} s of ${(wall / 1000).toFixed(2)} s wall time`);
  return at(1);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-graph-bench-'));
try {
  initStore(root);
  seedObjects(root);
  seedFiller(root, Math.max(0, MEMORIES - memoryCount(root)));
  console.log(`seeded ${POLICIES} policies, ${DECISIONS} decisions, ${memoryCount(root)} memories in ${root}`);

  const worst = Math.max(await measure('first build', root), await measure('unchanged rerun', root));
  if (worst > LIMIT_MS) {
    console.error(`FAIL: a graph chunk held the write lock ${worst.toFixed(1)} ms, over ${LIMIT_MS} ms`);
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
