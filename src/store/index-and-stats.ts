import {
  type DatabaseSyncLike,
  withWriteScope,
  setMeta,
  isSqliteBusy,
  pruneConsolidationRuns,
  getMeta,
} from '../db/index.js';
import { log } from '../util/log.js';
import type { HippoIndex } from './rows.js';
import { readLastRecall, writeStatsMirror, buildStatsFromDb } from './mirrors.js';
import { onHandle, openStore } from './open.js';
import { DAY_MS } from '../util/time.js';

/** The last recall's ids and its trace alone, for a caller that needs no index entry. */
export function loadLastRecall(hippoRoot: string): Pick<HippoIndex, 'last_retrieval_ids' | 'last_trace_id'> {
  return onHandle(hippoRoot, (db) => {
    return readLastRecall(db);
  }, openStore);
}

/** Persist mutable index metadata (entry rows are derived from SQLite); `last_retrieval_ids` and `last_trace_id` commit
 * in one transaction, as callers rely on both moving together. No hippo path writes index.json. */
export function saveIndex(hippoRoot: string, index: Pick<HippoIndex, 'last_retrieval_ids' | 'last_trace_id'>): void {
  onHandle(hippoRoot, (db) => {
    withWriteScope(db, 'save_index', () => {
      setMeta(db, 'last_retrieval_ids', JSON.stringify(index.last_retrieval_ids ?? []));
      setMeta(db, 'last_trace_id', index.last_trace_id ?? '');
    });
  }, openStore);
}

type StatsDelta = { remembered?: number; recalled?: number; forgotten?: number };

// Increments a busy store refused, one entry per root, folded into the next update that lands.
const pendingStats = new Map<string, Required<StatsDelta>>();

function addDelta(a: StatsDelta, b: StatsDelta): Required<StatsDelta> {
  return {
    remembered: (a.remembered ?? 0) + (b.remembered ?? 0),
    recalled: (a.recalled ?? 0) + (b.recalled ?? 0),
    forgotten: (a.forgotten ?? 0) + (b.forgotten ?? 0),
  };
}

export function updateStats(hippoRoot: string, delta: StatsDelta): void {
  const total = addDelta(pendingStats.get(hippoRoot) ?? {}, delta);
  onHandle(hippoRoot, (db) => {
    updateStatsOn(db, hippoRoot, total);
  }, openStore);
  pendingStats.delete(hippoRoot);
}

/** updateStats on the caller's open store, so a loop of writes opens the store once. */
export function updateStatsOn(db: DatabaseSyncLike, hippoRoot: string, delta: Parameters<typeof updateStats>[1]): void {
  // One atomic statement per named counter: a read-modify-write loses concurrent increments and stamps stale values
  // over the untouched two.
  const increments: ReadonlyArray<readonly [string, number]> = [
    ['total_remembered', delta.remembered ?? 0],
    ['total_recalled', delta.recalled ?? 0],
    ['total_forgotten', delta.forgotten ?? 0],
  ];
  for (const [key, amount] of increments) {
    if (amount === 0) continue;
    // Both binds are the same string: node:sqlite binds a JS number as REAL,
    // which would store "1.0" into this TEXT column instead of "1".
    db.prepare(`
      INSERT INTO meta(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + CAST(? AS INTEGER)
    `).run(key, String(amount), String(amount));
  }

  writeStatsMirror(hippoRoot, buildStatsFromDb(db));
}

export function updateStatsUnlessBusy(
  hippoRoot: string,
  delta: Parameters<typeof updateStats>[1],
  committed: string,
): void {
  try {
    updateStats(hippoRoot, delta);
  } catch (err) {
    if (!isSqliteBusy(err)) throw err;
    pendingStats.set(hippoRoot, addDelta(pendingStats.get(hippoRoot) ?? {}, delta));
    log.warnThenDebug('stats-busy', `${committed}, but the store was busy; the stats wait for the next update`);
  }
}

export function appendConsolidationRun(
  hippoRoot: string,
  run: { timestamp: string; decayed: number; merged: number; removed: number }
): void {
  onHandle(hippoRoot, (db) => {
    db.prepare(`INSERT INTO consolidation_runs(timestamp, decayed, merged, removed) VALUES (?, ?, ?, ?)`).run(
      run.timestamp,
      run.decayed,
      run.merged,
      run.removed
    );
    pruneConsolidationRuns(db);
    writeStatsMirror(hippoRoot, buildStatsFromDb(db));
  }, openStore);
}

/** Rows a tenant created since the last sleep (runs are host-wide), looking back at most 24 hours. */
export function createdSinceLastSleepAt(db: DatabaseSyncLike, tenantId: string, now: Date): number {
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE tenant_id = ?
       AND created > MAX(?, COALESCE((SELECT MAX(timestamp) FROM consolidation_runs), ''))`,
  ).get<{ n: number }>(tenantId, dayAgo);
  return row.n;
}

/** Session decay context: the data needed for session-based and adaptive decay. */
export interface SessionDecayContext {
  /** Total number of sleep (consolidation) cycles completed. */
  sleepCount: number;
  /** Average interval between recent sleep cycles, in days. 0 if < 2 cycles. */
  avgSessionIntervalDays: number;
}

/** Timestamp of the latest consolidation run, or undefined when there is none. */
export function lastConsolidationAt(db: DatabaseSyncLike): string | undefined {
  // SAFETY: row's shape matches the single `timestamp` column named in the SELECT.
  const row = db.prepare(`SELECT timestamp FROM consolidation_runs ORDER BY timestamp DESC, id DESC LIMIT 1`).get() as
    { timestamp?: string } | undefined;
  return row?.timestamp;
}

/** Load the session decay context; session intervals come from consolidation_runs timestamps. */
export function loadSessionDecayContext(hippoRoot: string): SessionDecayContext {
  return onHandle(hippoRoot, (db) => {
    // Get recent consolidation timestamps (last 20)
    // SAFETY: rows' shape matches the single `timestamp` column above.
    const rows = db.prepare(
      `SELECT timestamp FROM consolidation_runs ORDER BY timestamp DESC, id DESC LIMIT 20`
    ).all() as Array<{ timestamp: string }>;

    const sleepCount = Number(getMeta(db, 'sleep_count', '0')) || rows.length;

    if (rows.length < 2) {
      return { sleepCount, avgSessionIntervalDays: 0 };
    }

    // Compute average interval between consecutive sessions
    const timestamps = rows.map((r) => new Date(r.timestamp).getTime()).reverse();
    let totalInterval = 0;
    for (let i = 1; i < timestamps.length; i++) {
      totalInterval += timestamps[i] - timestamps[i - 1];
    }
    const avgMs = totalInterval / (timestamps.length - 1);
    const avgDays = avgMs / DAY_MS;

    return { sleepCount, avgSessionIntervalDays: Math.max(0, avgDays) };
  }, openStore);
}

/** Increment the sleep counter after each consolidation run. */
export function incrementSleepCount(hippoRoot: string): void {
  onHandle(hippoRoot, (db) => {
    const current = Number(getMeta(db, 'sleep_count', '0')) || 0;
    setMeta(db, 'sleep_count', String(current + 1));
  }, openStore);
}
