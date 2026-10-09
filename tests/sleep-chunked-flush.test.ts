// Sleep's flush commits whole units of work in short transactions and lets other writers in between,
// a run stopped between two of them leaves a consistent store, and an uninterrupted run ends where one transaction would.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { Worker } from 'node:worker_threads';
import { Layer, type MemoryEntry } from '../src/core/memory.js';
import { consolidate } from '../src/consolidate/sleep.js';
import { runSleep } from '../src/api/sleep-run.js';
import type { Context } from '../src/api/index.js';
import { initStore } from '../src/store/open.js';
import { upsertEntryRow } from '../src/store/entry-row.js';
import { mergedText } from '../src/util/same-text.js';
import { queryAuditEvents } from '../src/store/audit.js';
import { _resetAblationCacheForTests } from '../src/core/ablation.js';
import { closeHippoDb, getHippoDbPath, getMeta, HOOK_DB_WAIT_MS, openHippoDb, runWithRequestStores, withSharedStoreHandles, type DatabaseSyncLike } from '../src/db/index.js';
import { WRITE_BUDGET, type WriteBudget } from '../src/util/write-budget.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

const yieldOnce = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The real clock with the hold a test picks, and a pause that yields once instead of waiting out the real gap. */
const budget = (holdMs: number, pause: WriteBudget['pause'] = yieldOnce): WriteBudget => ({ ...WRITE_BUDGET, holdMs, pause });

// SAFETY: node:sqlite's DatabaseSync is the class db.ts wraps as DatabaseSyncLike.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: { new (path: string): DatabaseSyncLike; prototype: DatabaseSyncLike };
};

const DAY = 86_400_000;
const NOW = new Date('2026-06-01T12:00:00.000Z');
const MERGED_SQL = `SELECT COUNT(*) AS c FROM memories WHERE content LIKE '[Consolidated pattern%'`;
const roots: string[] = [];

// A thread, not a timer: the sleep's busy wait blocks this thread until the holder commits.
const HOLD_LOCK_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.file);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
parentPort.postMessage('locked');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.ms);
db.exec('COMMIT');
db.close();
`;

interface Fixture {
  root: string;
  clusters: string[][];
  dormant: string[];
  retired: string;
  keptSource: string;
  memberHalfLife: number;
}

function newRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-chunked-flush-'));
  roots.push(root);
  initStore(root);
  return root;
}

/** Three-row merge clusters first (sleep loads by created), then faded rows, one merged row holding a superseded text, and pinned rows sleep leaves alone. */
function seed(counts: { clusters: number; dormant: number; filler: number }): Fixture {
  let n = 0;
  const row = (text: string, ageDays: number, idleDays: number, opts: Parameters<typeof createMemory>[1] = {}): MemoryEntry => ({
    ...createMemory(text, opts),
    created: new Date(NOW.getTime() - ageDays * DAY + n++ * 1000).toISOString(),
    last_retrieved: new Date(NOW.getTime() - idleDays * DAY).toISOString(),
  });
  const clusters = Array.from({ length: counts.clusters }, (_, k) =>
    [0, 1, 2].map((j) => row(`c${k}alpha c${k}beta c${k}gamma c${k}delta variant v${j}`, 90, 1)));
  const dormant = Array.from({ length: counts.dormant }, (_, i) => ({ ...row(`faded d${i}alpha d${i}beta d${i}gamma`, 80, 60), half_life_days: 7 }));
  const kept = row('kept source beta text', 70, 1);
  const gone = { ...row('retired source alpha text', 70, 1), superseded_by: kept.id };
  const header = '[Consolidated from 2 related memories, newest first]';
  const retired = {
    ...row(mergedText(header, [kept.content, gone.content]), 70, 1, { layer: Layer.Semantic, source: 'consolidation' }),
    parents: [gone.id, kept.id],
  };
  const filler = Array.from({ length: counts.filler }, (_, i) => row(`pinned p${i}alpha p${i}beta p${i}gamma`, 60, 1, { pinned: true }));
  const root = newRoot();
  insertRows(root, [...clusters.flat(), ...dormant, kept, gone, retired, ...filler]);
  return {
    root,
    clusters: clusters.map((c) => c.map((e) => e.id)),
    dormant: dormant.map((e) => e.id),
    retired: retired.id,
    keptSource: kept.id,
    memberHalfLife: clusters[0]![0]!.half_life_days,
  };
}

/** One transaction on one handle, so seeding writes no mirrors and stays fast. */
function insertRows(root: string, rows: MemoryEntry[]): void {
  const db = openHippoDb(root);
  try {
    db.exec('BEGIN');
    for (const row of rows) upsertEntryRow(db, row);
    db.exec('COMMIT');
  } finally {
    closeHippoDb(db);
  }
}

function onStore<T>(root: string, read: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return read(db);
  } finally {
    closeHippoDb(db);
  }
}

function count(db: DatabaseSyncLike, sql: string): number {
  // SAFETY: every caller's SQL selects one COUNT(*) AS c.
  return Number((db.prepare(sql).get() as { c: number }).c);
}

function ids(db: DatabaseSyncLike, sql: string): string[] {
  // SAFETY: every caller's SQL selects one id column.
  return (db.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id).sort();
}

/** One write from a connection that never waits: it lands only while no transaction holds the lock. */
function probe(db: DatabaseSyncLike, seen: Array<{ merged: number; runs: number }>): void {
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    if (err instanceof Error && /locked|busy/i.test(err.message)) return;
    throw err;
  }
  upsertEntryRow(db, createMemory(`prober row number ${seen.length}`, { pinned: true }));
  seen.push({ merged: count(db, MERGED_SQL), runs: count(db, 'SELECT COUNT(*) AS c FROM consolidation_runs') });
  db.exec('COMMIT');
}

function callStack(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  try {
    return new Error().stack ?? '';
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/** Counts the batch writer's BEGIN IMMEDIATEs, leaving out the prober's and every other writer's. */
function countFlushBegins(prober: DatabaseSyncLike) {
  let begins = 0;
  const exec = DatabaseSync.prototype.exec;
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSyncLike, sql: string) {
    if (sql === 'BEGIN IMMEDIATE' && this !== prober && callStack().includes('batchWriteAndDelete')) begins++;
    exec.call(this, sql);
  });
  return { count: () => begins, restore: () => spy.mockRestore() };
}

/** Ids from a counter, so two runs mint the same ones; generateId keeps randomUUID's first 12 hex digits. */
async function withCountedIds<T>(run: () => Promise<T>): Promise<T> {
  let n = 0;
  const spy = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `${(++n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`);
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
}

/** Everything a flush writes, minus wall-clock stamps (updated_at, audit ts) and autoincrement ids. */
function storeState(root: string) {
  return onStore(root, (db) => {
    const all = (sql: string): unknown[] => db.prepare(sql).all();
    // SAFETY: pragma_table_info yields one row per column with its name.
    const columns = (all(`SELECT name FROM pragma_table_info('memories') WHERE name != 'updated_at'`) as Array<{ name: string }>).map((c) => c.name);
    return {
      memories: all(`SELECT ${columns.join(', ')} FROM memories ORDER BY id`),
      fts: all('SELECT id, content, tags FROM memories_fts ORDER BY id, content'),
      dormant: all('SELECT * FROM dormant_memories ORDER BY tenant_id, id'),
      audit: all('SELECT tenant_id, actor, op, target_id, metadata_json FROM audit_log ORDER BY op, target_id, metadata_json'),
      runs: all('SELECT timestamp, decayed, merged, removed FROM consolidation_runs ORDER BY id'),
      sleepCount: getMeta(db, 'sleep_count', '0'),
      mirrors: fs.readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('hippo.db'))
        .map((e) => path.relative(root, path.join(e.parentPath, e.name)).replace(/\\/g, '/'))
        .sort(),
    };
  });
}

/** The crash contract's checks, read in one pass. */
function storeFacts(fx: Fixture) {
  return onStore(fx.root, (db) => {
    const memoryIds = ids(db, 'SELECT id FROM memories');
    const present = new Set(memoryIds);
    // SAFETY: both SELECTs name the columns their casts read.
    const halfLife = new Map((db.prepare('SELECT id, half_life_days FROM memories').all() as Array<{ id: string; half_life_days: number }>).map((r) => [r.id, r.half_life_days]));
    // SAFETY: parents_json is NOT NULL and always holds the JSON array of ids writeEntry stored.
    const merges = (db.prepare(`SELECT parents_json FROM memories WHERE source = 'consolidation'`).all() as Array<{ parents_json: string }>)
      .map((r) => JSON.parse(r.parents_json) as string[]);
    const clusterParents = merges.filter((p) => p.length === 3);
    const allParents = merges.flat();
    const dormantIds = ids(db, 'SELECT id FROM dormant_memories');
    return {
      memoryIds,
      ftsIds: ids(db, 'SELECT id FROM memories_fts'),
      merged: clusterParents.length,
      parentsDemoted: clusterParents.flat().every((id) => (halfLife.get(id) ?? Infinity) < fx.memberHalfLife),
      retiredXorSuccessor: present.has(fx.retired) !== merges.some((p) => p.length === 1 && p[0] === fx.keptSource),
      sharedParents: allParents.filter((id, i) => allParents.indexOf(id) !== i),
      inBoth: dormantIds.filter((id) => present.has(id)),
      dormantMoved: fx.dormant.every((id) => dormantIds.includes(id) && !present.has(id)),
      runRecord: {
        runs: count(db, 'SELECT COUNT(*) AS c FROM consolidation_runs'),
        sleepCount: getMeta(db, 'sleep_count', '0'),
        rescues: count(db, `SELECT COUNT(*) AS c FROM audit_log WHERE op = 'mv_rescue'`),
      },
    };
  });
}

beforeEach(() => {
  _resetAblationCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetAblationCacheForTests();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe('chunked consolidation flush', () => {
  it('lets another writer in between chunks, before the run is logged', async () => {
    const fx = seed({ clusters: 100, dormant: 60, filler: 1_637 });
    const prober = new DatabaseSync(getHippoDbPath(fx.root));
    prober.exec('PRAGMA busy_timeout = 0');
    const seen: Array<{ merged: number; runs: number }> = [];
    const flushBegins = countFlushBegins(prober);
    const timer = setInterval(() => probe(prober, seen), 5);
    try {
      await consolidate(fx.root, { now: NOW, budget: budget(0) });
    } finally {
      clearInterval(timer);
      flushBegins.restore();
      prober.close();
    }

    const final = onStore(fx.root, (db) => count(db, MERGED_SQL));
    expect(final).toBe(100);
    expect(seen.some((s) => s.merged > 0 && s.merged < final && s.runs === 0)).toBe(true);
    expect(flushBegins.count()).toBeGreaterThanOrEqual(10);
  }, 120_000);

  it('ends with the same store whether the flush commits per unit or all at once', async () => {
    vi.stubEnv('HIPPO_FAKE_NOW', NOW.toISOString());
    _resetAblationCacheForTests();
    const fx = seed({ clusters: 30, dormant: 20, filler: 40 });
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-chunked-flush-'));
    roots.push(copy);
    fs.cpSync(fx.root, copy, { recursive: true });

    const chunked = await withCountedIds(() => consolidate(fx.root, { now: NOW, budget: budget(0) }));
    const whole = await withCountedIds(() => consolidate(copy, { now: NOW, budget: budget(Infinity) }));

    expect(chunked.semanticCreated).toBe(30);
    expect(chunked.dormant).toBe(20);
    expect(chunked).toEqual(whole);
    expect(storeState(fx.root)).toEqual(storeState(copy));
  }, 60_000);

  it('a run stopped between chunks keeps whole units and logs no run, and the next run finishes it', async () => {
    let pauses = 0;
    const stopsOnSecondPause = budget(0, async () => {
      if (++pauses === 2) throw new Error('stopped between chunks');
      await yieldOnce();
    });
    const fx = seed({ clusters: 12, dormant: 10, filler: 20 });
    const ctx: Context = { hippoRoot: fx.root, tenantId: 'default', actor: { subject: 'sleep-test', role: 'admin' } };
    const atNow: typeof consolidate = (root, opts) => consolidate(root, { ...opts, now: NOW, budget: stopsOnSecondPause });

    await expect(runSleep(ctx, { noShare: true }, { consolidate: atNow })).rejects.toThrow('stopped between chunks');

    const stopped = storeFacts(fx);
    expect(stopped.merged).toBeGreaterThan(0);
    expect(stopped.merged).toBeLessThan(12);
    expect(stopped.parentsDemoted).toBe(true);
    expect(stopped.retiredXorSuccessor).toBe(true);
    expect(stopped.inBoth).toEqual([]);
    expect(stopped.ftsIds).toEqual(stopped.memoryIds);
    expect(stopped.runRecord).toEqual({ runs: 0, sleepCount: '0', rescues: 0 });
    const [audit] = onStore(fx.root, (db) => queryAuditEvents(db, { tenantId: '__host__', op: 'consolidate' }));
    expect(audit?.metadata).toMatchObject({ partial: true, nextUnitIds: expect.arrayContaining(fx.clusters[2]!) });

    await consolidate(fx.root, { now: NOW, budget: budget(0) });
    const finished = storeFacts(fx);
    expect(finished.merged).toBe(12);
    expect(finished.retiredXorSuccessor).toBe(true);
    expect(finished.sharedParents).toEqual([]);
    expect(finished.dormantMoved).toBe(true);
    expect(finished.ftsIds).toEqual(finished.memoryIds);
  }, 60_000);

  it('a sleep inside a server request waits out a writer that holds the lock between chunks', async () => {
    const fx = seed({ clusters: 4, dormant: 2, filler: 4 });
    let exited: Promise<unknown[]> | undefined;
    const holdsOnFirstPause = budget(0, async () => {
      if (exited) return yieldOnce();
      const holder = new Worker(HOLD_LOCK_WORKER, { eval: true, workerData: { file: getHippoDbPath(fx.root), ms: 400 } });
      exited = once(holder, 'exit');
      await once(holder, 'message');
    });

    const result = await runWithRequestStores(() => consolidate(fx.root, { now: NOW, budget: holdsOnFirstPause }), { busyWaitMs: 250 });

    expect(exited).toBeDefined();
    expect(await exited).toEqual([0]);
    expect(result.semanticCreated).toBe(4);
  }, 60_000);

  it('the partial audit row names the unit that threw, not the first unit of its chunk', async () => {
    const fx = seed({ clusters: 6, dormant: 0, filler: 0 });
    const bad = fx.clusters[3]!;
    onStore(fx.root, (db) => db.exec(
      `CREATE TRIGGER boom BEFORE UPDATE ON memories WHEN NEW.id = '${bad[0]}' BEGIN SELECT RAISE(ABORT, 'boom'); END`));
    const ctx: Context = { hippoRoot: fx.root, tenantId: 'default', actor: { subject: 'sleep-test', role: 'admin' } };
    const oneChunk: typeof consolidate = (root, opts) => consolidate(root, { ...opts, now: NOW, budget: budget(Infinity) });

    await expect(runSleep(ctx, { noShare: true }, { consolidate: oneChunk })).rejects.toThrow('boom');

    const [audit] = onStore(fx.root, (db) => queryAuditEvents(db, { tenantId: '__host__', op: 'consolidate' }));
    expect(audit?.metadata).toMatchObject({ partial: true, nextUnitIds: expect.arrayContaining(bad) });
    // SAFETY: consolidate writes nextUnitIds into the partial audit metadata as an array of unit ids.
    const meta = audit?.metadata as { nextUnitIds: string[] } | undefined;
    expect(meta?.nextUnitIds).not.toContain(fx.clusters[0]![0]);
  }, 60_000);

  it('a sleep inside shared hook handles leaves their lock wait as it was', async () => {
    const fx = seed({ clusters: 2, dormant: 0, filler: 0 });
    const timeout = await withSharedStoreHandles(async () => {
      await consolidate(fx.root, { now: NOW, budget: budget(0) });
      const db = openHippoDb(fx.root);
      // SAFETY: PRAGMA busy_timeout returns one row with one integer column named timeout.
      return (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
    }, { busyWaitMs: HOOK_DB_WAIT_MS });
    expect(timeout).toBe(HOOK_DB_WAIT_MS);
  }, 60_000);
});
