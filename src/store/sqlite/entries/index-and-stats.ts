import {
  type DatabaseSyncLike,
  withWriteScope,
  setMeta,
  isSqliteBusy,
  pruneConsolidationRuns,
} from '../../../db/index.js';
import { errorFields, log } from '../../../base/util/log.js';
import type { HippoIndex } from '../runtime/rows.js';
import { writeStatsMirror, buildStatsFromDb } from '../folder-files/mirrors.js';
import type { Handles, StoreFiles } from '../runtime/open.js';
import { openStore } from '../runtime/handles.js';
import { bound } from '../runtime/bound.js';
import type { StoreAt } from '../../../db/connect.js';
import { DAY_MS } from '../../../base/util/time.js';
import { cachedStatement } from '../../../db/statement-cache.js';

import type { SleepStart } from '../../../base/ports/store/consolidation.js';
import { META_KEY, getMetaNumber } from '../../../db/meta.js';

/** Persist mutable index metadata (entry rows are derived from SQLite); `last_retrieval_ids` and
 * `last_trace_id` commit in one transaction, as callers rely on both moving together. No hippo
 * path writes index.json. */
export function saveIndex(
  db: DatabaseSyncLike,
  index: Pick<HippoIndex, 'last_retrieval_ids' | 'last_trace_id'>,
): void {
  withWriteScope(db, 'save_index', () => {
    setMeta(db, META_KEY.lastRetrievalIds, JSON.stringify(index.last_retrieval_ids ?? []));
    setMeta(db, META_KEY.lastTraceId, index.last_trace_id ?? '');
  });
}

type StatsDelta = { remembered?: number; recalled?: number; forgotten?: number };

function addDelta(a: StatsDelta, b: StatsDelta): Required<StatsDelta> {
  return {
    remembered: (a.remembered ?? 0) + (b.remembered ?? 0),
    recalled: (a.recalled ?? 0) + (b.recalled ?? 0),
    forgotten: (a.forgotten ?? 0) + (b.forgotten ?? 0),
  };
}

/** The store-wide counters a local write moves, beside the rows it wrote. */
export function sqliteStats({ on, files }: Handles) {
  return bound(
    on,
    {
      /** Adds `count` to the one store-wide remembered counter, no tenant. Its rows have
       * committed, so a busy store never fails the write; a store runtime holds the count. */
      bumpRemembered: (db: DatabaseSyncLike, count: number) =>
        updateStatsUnlessBusy(db, files, { remembered: count }, `remembered ${count}`),
    },
    openStore,
  );
}

/** updateStats on the caller's open store, so a loop of writes opens the store once. */
export function updateStats(db: DatabaseSyncLike, files: StoreFiles, delta: StatsDelta): void {
  // Increments a busy store refused, held by the runtime and folded into the next update that
  // lands.
  const { runtime } = files;
  const total = addDelta(runtime?.takeStats(files.hippoRoot) ?? {}, delta);
  try {
    updateStatsOn(db, files, total);
  } catch (err) {
    runtime?.holdStats(files.hippoRoot, total);
    throw err;
  }
}

export function updateStatsOn(db: DatabaseSyncLike, at: StoreAt, delta: StatsDelta): void {
  // One atomic statement per named counter: a read-modify-write loses concurrent increments and
  // stamps stale values over the untouched two.
  const increments: ReadonlyArray<readonly [string, number]> = [
    [META_KEY.totalRemembered, delta.remembered ?? 0],
    [META_KEY.totalRecalled, delta.recalled ?? 0],
    [META_KEY.totalForgotten, delta.forgotten ?? 0],
  ];
  for (const [key, amount] of increments) {
    if (amount === 0) continue;
    // Both binds are the same string: node:sqlite binds a JS number as REAL, which would store
    // "1.0" into this TEXT column instead of "1".
    cachedStatement(
      db,
      `
      INSERT INTO meta(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + CAST(? AS INTEGER)
    `,
    ).run(key, String(amount), String(amount));
  }

  writeStatsMirror(at, buildStatsFromDb(db));
}

export function updateStatsUnlessBusy(
  db: DatabaseSyncLike,
  files: StoreFiles,
  delta: StatsDelta,
  committed: string,
): void {
  try {
    updateStats(db, files, delta);
  } catch (err) {
    if (!isSqliteBusy(err)) throw err;
    log.warnThenDebug(
      'stats-busy',
      `${committed}, but the store was busy; the stats wait for the next update`,
      errorFields(err),
    );
  }
}

export function appendConsolidationRun(
  db: DatabaseSyncLike,
  files: StoreFiles,
  run: { timestamp: string; decayed: number; merged: number; removed: number },
): void {
  cachedStatement(
    db,
    `INSERT INTO consolidation_runs(timestamp, decayed, merged, removed) VALUES (?, ?, ?, ?)`,
  ).run(run.timestamp, run.decayed, run.merged, run.removed);
  pruneConsolidationRuns(db);
  writeStatsMirror(files, buildStatsFromDb(db));
}

/** Rows a tenant created since the last sleep (runs are host-wide), looking back at most 24
 * hours. */
export function createdSinceLastSleep(db: DatabaseSyncLike, tenantId: string, now: Date): number {
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const row = cachedStatement(
    db,
    `SELECT COUNT(*) AS n FROM memories WHERE tenant_id = ?
       AND created > MAX(?, COALESCE((SELECT MAX(timestamp) FROM consolidation_runs), ''))`,
  ).get(tenantId, dayAgo) as { n: number };
  return row.n;
}

/** Timestamp of the latest consolidation run, or undefined when there is none. */
export function lastConsolidation(db: DatabaseSyncLike): string | undefined {
  const row = cachedStatement(
    db,
    `SELECT timestamp FROM consolidation_runs ORDER BY timestamp DESC, id DESC LIMIT 1`,
  ).get() as { timestamp?: string } | undefined;
  return row?.timestamp;
}

/** The stored sleep count (0 when none) and the newest 20 run times, newest first. */
export function readSleepHistory(
  db: DatabaseSyncLike,
): Pick<SleepStart, 'sleepCount' | 'recentRuns'> {
  const rows = cachedStatement(
    db,
    `SELECT timestamp FROM consolidation_runs ORDER BY timestamp DESC, id DESC LIMIT 20`,
  ).all() as Array<{ timestamp: string }>;
  return {
    sleepCount: getMetaNumber(db, META_KEY.sleepCount),
    recentRuns: rows.map((r) => r.timestamp),
  };
}

/** Increment the sleep counter after each consolidation run. */
export function incrementSleepCount(db: DatabaseSyncLike): void {
  const current = getMetaNumber(db, META_KEY.sleepCount);
  setMeta(db, META_KEY.sleepCount, String(current + 1));
}
