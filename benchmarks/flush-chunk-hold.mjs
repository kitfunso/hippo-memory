// How long each of sleep's flush transactions holds the write lock, on a store built under the OS temp folder.
// Run by hand after `npm run build`, never in CI: node benchmarks/flush-chunk-hold.mjs [rows]. Exits 1 when a chunk holds over 150 ms.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../dist/core/memory.js';
import { initStore } from '../dist/store/open.js';
import { upsertEntryRow } from '../dist/store/entry-row.js';
import { openHippoDb, closeHippoDb } from '../dist/db/index.js';
import { consolidate } from '../dist/consolidate/sleep.js';

const LIMIT_MS = 150;
const DAY = 86_400_000;
const NOW = new Date('2026-06-01T12:00:00.000Z');
const ROWS = Number(process.argv[2] ?? 20_000);

/** 5% of rows in three-row merge clusters, 5% faded enough to go dormant, the rest decay writes with no text change. */
function fixture(n) {
  let k = 0;
  const row = (text, ageDays, idleDays, extra = {}) => ({
    ...createMemory(text, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
    created: new Date(NOW.getTime() - ageDays * DAY + k++ * 1000).toISOString(),
    last_retrieved: new Date(NOW.getTime() - idleDays * DAY).toISOString(),
    ...extra,
  });
  const out = [];
  for (let c = 0; c < Math.floor(n / 60); c++) {
    for (let j = 0; j < 3; j++) out.push(row(`c${c}alpha c${c}beta c${c}gamma c${c}delta variant v${j}`, 90, 1));
  }
  for (let i = 0; i < Math.floor(n / 20); i++) out.push(row(`f${i}alpha f${i}beta f${i}gamma`, 80, 60, { half_life_days: 7 }));
  while (out.length < n) {
    const i = out.length;
    out.push(row(`n${i}alpha n${i}beta n${i}gamma n${i}delta`, 30, 1 + (i % 10)));
  }
  return out;
}

function seed(root, rows) {
  const db = openHippoDb(root);
  try {
    db.exec('BEGIN');
    for (const row of rows) upsertEntryRow(db, row);
    db.exec('COMMIT');
  } finally {
    closeHippoDb(db);
  }
}

/** Records BEGIN IMMEDIATE to COMMIT for every transaction the flush opens, and nothing else's. */
function timeFlushChunks() {
  const holds = [];
  const begunAt = new WeakMap();
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    const flushBegin = sql === 'BEGIN IMMEDIATE' && (new Error().stack ?? '').includes('batchWriteAndDeleteOn');
    const result = exec.call(this, sql);
    if (flushBegin) begunAt.set(this, performance.now());
    if (sql === 'COMMIT' && begunAt.has(this)) {
      holds.push(performance.now() - begunAt.get(this));
      begunAt.delete(this);
    }
    return result;
  };
  return { holds, restore: () => { DatabaseSync.prototype.exec = exec; } };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-flush-bench-'));
try {
  initStore(root);
  const rows = fixture(ROWS);
  seed(root, rows);
  console.log(`seeded ${rows.length} rows in ${root}`);

  const timer = timeFlushChunks();
  const started = performance.now();
  let result;
  try {
    result = await consolidate(root, { now: NOW });
  } finally {
    timer.restore();
  }
  const wall = performance.now() - started;
  const sorted = [...timer.holds].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const total = sorted.reduce((s, x) => s + x, 0);
  console.log(`merged ${result.semanticCreated} clusters, ${result.dormant} dormant, ${result.decayed} decayed`);
  console.log(`chunks ${sorted.length}  max ${at(1).toFixed(1)} ms  median ${at(0.5).toFixed(1)} ms  p95 ${at(0.95).toFixed(1)} ms`);
  console.log(`locked ${(total / 1000).toFixed(2)} s of ${(wall / 1000).toFixed(2)} s sleep wall time`);
  if (at(1) > LIMIT_MS) {
    console.error(`FAIL: a flush chunk held the write lock ${at(1).toFixed(1)} ms, over ${LIMIT_MS} ms`);
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
