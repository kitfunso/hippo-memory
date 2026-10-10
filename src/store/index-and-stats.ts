import { type DatabaseSyncLike, closeHippoDb, withWriteScope, setMeta, isSqliteBusy, pruneConsolidationRuns, getMeta } from '../db/index.js';
import { RejectedValueError } from './rejection.js';
import { log } from '../util/log.js';
import type { HippoIndex, LegacyStats } from './rows.js';
import { audit } from './audit-event.js';
import { stampOriginProjectForImport, upsertEntryRow } from './entry-row.js';
import { buildIndexFromDb, readLastRecall, syncMirrorFiles, writeIndexMirror, writeStatsMirror, buildStatsFromDb } from './mirrors.js';
import { openStore, loadLegacyEntriesFromMarkdown } from './open.js';
import { DAY_MS } from '../util/time.js';

/** Load the derived index from SQLite. Read-only: index.json is only ever written by `rebuildIndex`. */
export function loadIndex(hippoRoot: string): HippoIndex {
  const db = openStore(hippoRoot);
  try {
    return buildIndexFromDb(db);
  } finally {
    closeHippoDb(db);
  }
}

/** The last recall's ids and its trace alone, for a caller that needs no index entry. */
export function loadLastRecall(hippoRoot: string): Pick<HippoIndex, 'last_retrieval_ids' | 'last_trace_id'> {
  const db = openStore(hippoRoot);
  try {
    return readLastRecall(db);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Persist mutable index metadata. Entry rows themselves are derived from SQLite.
 *
 * `last_retrieval_ids` and `last_trace_id` commit in one transaction: callers fold a fresh trace id
 * into the index and rely on both keys moving together. index.json is left to `rebuildIndex`.
 */
export function saveIndex(hippoRoot: string, index: Pick<HippoIndex, 'last_retrieval_ids' | 'last_trace_id'>): void {
  const db = openStore(hippoRoot);
  try {
    withWriteScope(db, 'save_index', () => {
      setMeta(db, 'last_retrieval_ids', JSON.stringify(index.last_retrieval_ids ?? []));
      setMeta(db, 'last_trace_id', index.last_trace_id ?? '');
    });
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Rebuild mirrors from SQLite, importing any legacy markdown files not already present.
 */
export function rebuildIndex(hippoRoot: string): HippoIndex {
  const db = openStore(hippoRoot);
  try {
    // SAFETY: rows' shape matches the single `id` column selected above.
    const existingIds = new Set(
      (db.prepare(`SELECT id FROM memories`).all() as Array<{ id: string }>).map((row) => row.id)
    );
    const legacyEntries = loadLegacyEntriesFromMarkdown(hippoRoot).filter((entry) => !existingIds.has(entry.id));
    if (legacyEntries.length > 0) {
      withWriteScope(db, 'rebuild_index', () => {
        // Guard with per-row skip, like bootstrapLegacyStore: a stale markdown mirror could resurrect a
        // rejected value here. Refusal audit is written inline because nothing rolls back on a skip.
        let rejectedCount = 0;
        for (const entry of legacyEntries) {
          // v39: same store-derived origin stamp as bootstrapLegacyStore.
          const stamped = stampOriginProjectForImport(hippoRoot, entry);
          try {
            upsertEntryRow(db, stamped);
          } catch (err) {
            if (err instanceof RejectedValueError) {
              rejectedCount++;
              audit(db, 'reject_refusal', {
                targetId: err.entryId,
                metadata: { digest: err.digest, reason: err.reason },
                actor: 'cli',
                tenantId: err.tenantId
              });
              continue;
            }
            throw err;
          }
        }
        if (rejectedCount > 0) {
          log.warn(`rebuildIndex: skipped ${rejectedCount} rejected value(s) found in legacy mirrors`);
        }
      });
    }

    syncMirrorFiles(hippoRoot, db);
    const index = buildIndexFromDb(db);
    writeIndexMirror(hippoRoot, index);
    return index;
  } finally {
    closeHippoDb(db);
  }
}

export function updateStats(
  hippoRoot: string,
  delta: { remembered?: number; recalled?: number; forgotten?: number }
): void {
  const db = openStore(hippoRoot);
  try {
    updateStatsOn(db, hippoRoot, delta);
  } finally {
    closeHippoDb(db);
  }
}

/** updateStats on the caller's open store, so a loop of writes opens the store once. */
export function updateStatsOn(db: DatabaseSyncLike, hippoRoot: string, delta: Parameters<typeof updateStats>[1]): void {
  // One atomic statement per counter, and only for counters the caller
  // named: the read-modify-write this replaces both lost increments to a
  // concurrent writer and stamped stale values over the untouched two.
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

export function updateStatsUnlessBusy(hippoRoot: string, delta: Parameters<typeof updateStats>[1], committed: string): void {
  try {
    updateStats(hippoRoot, delta);
  } catch (err) {
    if (!isSqliteBusy(err)) throw err;
    log.warnThenDebug('stats-busy', `${committed}, but the store was busy, so the stats counters were not updated`);
  }
}

export function loadStats(hippoRoot: string): LegacyStats {
  const db = openStore(hippoRoot);
  try {
    return buildStatsFromDb(db);
  } finally {
    closeHippoDb(db);
  }
}

export function appendConsolidationRun(
  hippoRoot: string,
  run: { timestamp: string; decayed: number; merged: number; removed: number }
): void {
  const db = openStore(hippoRoot);
  try {
    db.prepare(`INSERT INTO consolidation_runs(timestamp, decayed, merged, removed) VALUES (?, ?, ?, ?)`).run(
      run.timestamp,
      run.decayed,
      run.merged,
      run.removed
    );
    pruneConsolidationRuns(db, 50);
    writeStatsMirror(hippoRoot, buildStatsFromDb(db));
  } finally {
    closeHippoDb(db);
  }
}

/** Rows a tenant created since the last sleep (runs are host-wide), looking back at most 24 hours. */
export function countCreatedSinceLastSleep(hippoRoot: string, tenantId: string, now: Date = new Date()): number {
  const db = openStore(hippoRoot);
  try {
    const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM memories WHERE tenant_id = ?
         AND created > MAX(?, COALESCE((SELECT MAX(timestamp) FROM consolidation_runs), ''))`,
    ).get<{ n: number }>(tenantId, dayAgo);
    return row.n;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Session decay context: provides the data needed for session-based and adaptive decay.
 */
export interface SessionDecayContext {
  /** Total number of sleep (consolidation) cycles completed. */
  sleepCount: number;
  /** Average interval between recent sleep cycles, in days. 0 if < 2 cycles. */
  avgSessionIntervalDays: number;
}

/** Timestamp of the latest consolidation run, or undefined when there is none. */
export function lastConsolidationAt(db: DatabaseSyncLike): string | undefined {
  // SAFETY: row's shape matches the single `timestamp` column named in the SELECT.
  const row = db.prepare(`SELECT timestamp FROM consolidation_runs ORDER BY timestamp DESC, id DESC LIMIT 1`).get() as { timestamp?: string } | undefined;
  return row?.timestamp;
}

/**
 * Load the session decay context from the store.
 * Uses consolidation_runs timestamps to compute session intervals.
 */
export function loadSessionDecayContext(hippoRoot: string): SessionDecayContext {
  const db = openStore(hippoRoot);
  try {
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
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Increment the sleep counter. Called after each consolidation run.
 */
export function incrementSleepCount(hippoRoot: string): void {
  const db = openStore(hippoRoot);
  try {
    const current = Number(getMeta(db, 'sleep_count', '0')) || 0;
    setMeta(db, 'sleep_count', String(current + 1));
  } finally {
    closeHippoDb(db);
  }
}
