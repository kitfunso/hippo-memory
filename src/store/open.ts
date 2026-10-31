// Opens the SQLite store, the source of truth; Markdown and JSON files are human-readable mirrors of it.

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_HALF_LIFE_DAYS, type MemoryEntry, Layer } from '../core/memory.js';
import {
  closeHippoDb,
  currentRequestStores,
  type DatabaseSyncLike,
  openHippoDb,
  getMeta,
  setMeta,
  withWriteScope,
  pruneConsolidationRuns,
} from '../db/index.js';
import { openHippoDbWithFacts } from '../db/open.js';
import { RejectedValueError } from '../core/api-errors.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { type HippoIndex, type LegacyStats } from './rows.js';
import { audit } from './audit-event.js';
import { deserializeEntry } from '../core/markdown.js';
import { stampOriginProjectForImport, upsertEntryRow } from './entry-row.js';
import { ensureMirrorDirectories, syncMirrorFiles, layerDir } from './mirrors.js';
import { isJsonObject, type JsonValue } from '../util/json.js';

export function initStore(hippoRoot: string): void {
  closeHippoDb(openStore(hippoRoot));
}

/** One open connection with init done on it, for callers who used to pay for `initStore` + a second `openHippoDb`. */
export function openStore(hippoRoot: string, opts?: { busyWaitMs?: number }): DatabaseSyncLike {
  // Open first: a folder marked for another store must refuse before any mirror folder appears.
  const { db, facts } = openHippoDbWithFacts(hippoRoot, opts);
  // A store worker's reader: its writer ran the steps below before this thread was sent a job, and this connection
  // cannot write them.
  if (currentRequestStores()?.setupDoneFor === hippoRoot) return db;
  try {
    ensureMirrorDirectories(hippoRoot);
    // Both steps act only on a store with no memory row, which the open's own probe has just ruled out.
    if (facts?.hasMemories) return db;
    const bootstrapped = bootstrapLegacyStore(db, hippoRoot);
    if (bootstrapped) {
      syncMirrorFiles(hippoRoot, db);
    }
    recordHalfLifeBaseForNewStore(db);
    return db;
  } catch (error) {
    try {
      closeHippoDb(db);
    } catch (closeErr) {
      // The init error is the one thrown; the close failure is only logged.
      log.error(
        `openStore: closing the handle after a failed init failed: ${errorMessage(closeErr)}`,
        errorFields(closeErr),
      );
    }
    throw error;
  }
}

/** A connection with no mirror or legacy setup, for a caller that already ran `initStore`. */
export function openBareHandle(hippoRoot: string, opts?: { busyWaitMs?: number }): DatabaseSyncLike {
  return openHippoDb(hippoRoot, opts);
}

/** One call on a handle of its own, closed after (a request scope's handle stays open);
 *  pass openStore where the call also sets up mirror folders and legacy rows. */
export function onHandle<T>(
  hippoRoot: string,
  fn: (db: DatabaseSyncLike) => T,
  open: (hippoRoot: string) => DatabaseSyncLike = openHippoDb,
): T {
  const db = open(hippoRoot);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** `meta` key holding the default half-life base a store's memories are on (src/consolidate/half-life-migration.ts). */
export const HALF_LIFE_BASE_META_KEY = 'default_half_life_base';
/** `meta` key set once no memory of a decision, incident or other object sits on the old flat 90 days. */
export const TYPED_HALF_LIFE_META_KEY = 'typed_half_life_on_default';

/** A store with no memories starts on the current default half-life base so `hippo sleep` never migrates it; one that
 * holds memories but no recorded base predates the record and keeps the legacy 7-day base until sleep migrates it. */
function recordHalfLifeBaseForNewStore(db: DatabaseSyncLike): void {
  if (getMeta(db, HALF_LIFE_BASE_META_KEY, '') !== '') return;
  if (db.prepare(`SELECT 1 AS x FROM memories LIMIT 1`).get() !== undefined) return;
  setMeta(db, HALF_LIFE_BASE_META_KEY, String(DEFAULT_HALF_LIFE_DAYS));
  setMeta(db, TYPED_HALF_LIFE_META_KEY, '1');
}

function bootstrapLegacyStore(db: ReturnType<typeof openHippoDb>, hippoRoot: string): boolean {
  // Existence, not COUNT(*): a count walks every row on each write's open.
  if (db.prepare(`SELECT 1 AS x FROM memories LIMIT 1`).get() !== undefined) return false;
  // The row check misses an all-rejected bootstrap (memories stays empty), which would re-run the
  // import on every open and duplicate consolidation_runs; this meta flag settles it.
  if (getMeta(db, 'legacy_bootstrap_completed', '0') === '1') return false;

  const legacyEntries = loadLegacyEntriesFromMarkdown(hippoRoot);
  if (legacyEntries.length === 0) return false;

  withWriteScope(db, 'bootstrap_legacy_store', () => {
    importLegacyEntries(db, hippoRoot, legacyEntries);
    importLegacyIndexAndStats(db, hippoRoot);

    // Stamp completion even when every row was rejected; see the gate above.
    setMeta(db, 'legacy_bootstrap_completed', '1');
  });
  return true;
}

function importLegacyEntries(db: DatabaseSyncLike, hippoRoot: string, legacyEntries: MemoryEntry[]): void {
  // Guard live per row: a stale markdown mirror could resurrect a rejected value. Plain audit()
  // inline, because nothing rolls back on a per-row skip.
  let rejectedCount = 0;
  for (const entry of legacyEntries) {
    // v39: legacy markdown carries no origin_project; stamp from the store
    // location so bootstrapped rows stay visible to ambient context.
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
          tenantId: err.tenantId,
        });
        continue;
      }
      throw err;
    }
  }
  if (rejectedCount > 0) {
    log.warn(`bootstrapLegacyStore: skipped ${rejectedCount} rejected value(s) found in legacy mirrors`);
  }
}

function importLegacyIndexAndStats(db: DatabaseSyncLike, hippoRoot: string): void {
  const legacyIndex = loadLegacyIndexFile(hippoRoot);
  setMeta(db, 'last_retrieval_ids', JSON.stringify(legacyIndex.last_retrieval_ids ?? []));
  // Legacy index.json predates last_trace_id, so '' is normal; accept only a clean digit
  // string rather than trusting a hand-edited or corrupt index.json.
  const legacyTraceId = String(legacyIndex.last_trace_id ?? '');
  setMeta(db, 'last_trace_id', /^\d+$/.test(legacyTraceId) ? legacyTraceId : '');

  const legacyStats = loadLegacyStatsFile(hippoRoot);
  setMeta(db, 'total_remembered', String(Number(legacyStats.total_remembered ?? 0)));
  setMeta(db, 'total_recalled', String(Number(legacyStats.total_recalled ?? 0)));
  setMeta(db, 'total_forgotten', String(Number(legacyStats.total_forgotten ?? 0)));

  const runs = Array.isArray(legacyStats.consolidation_runs) ? legacyStats.consolidation_runs : [];
  const insertRun = db.prepare(
    `INSERT INTO consolidation_runs(timestamp, decayed, merged, removed) VALUES (?, ?, ?, ?)`,
  );
  for (const run of runs) {
    if (!isJsonObject(run)) continue;
    const row = run;
    insertRun.run(
      String(row.timestamp ?? new Date().toISOString()),
      Number(row.decayed ?? 0),
      Number(row.merged ?? 0),
      Number(row.removed ?? 0)
    );
  }
  // Same cap as every later sleep, so stats.json and the table agree from the first open.
  pruneConsolidationRuns(db);
}

export function loadLegacyEntriesFromMarkdown(hippoRoot: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const layer of [Layer.Buffer, Layer.Episodic, Layer.Semantic]) {
    const dir = layerDir(hippoRoot, layer);
    if (!fs.existsSync(dir)) continue;

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      try {
        const entry = deserializeEntry(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (entry) entries.push(entry);
      } catch (err) {
        log.warn(`store: skipped unreadable legacy file ${file}: ${errorMessage(err)}`, errorFields(err));
      }
    }
  }
  return entries;
}

function readLegacyJsonObject(file: string): { [key: string]: JsonValue } | null {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log.warn(`store: unreadable ${path.basename(file)} read as empty: ${errorMessage(err)}`, errorFields(err));
    return null;
  }
  if (!isJsonObject(parsed)) {
    log.warn(`store: ${path.basename(file)} is not a JSON object, read as empty`);
    return null;
  }
  return parsed;
}

function loadLegacyIndexFile(hippoRoot: string): HippoIndex {
  const indexPath = path.join(hippoRoot, 'index.json');
  const empty: HippoIndex = { version: 1, entries: {}, last_retrieval_ids: [], last_trace_id: null };
  if (!fs.existsSync(indexPath)) return empty;
  // SAFETY: index.json is written by writeIndexMirror as a HippoIndex; readers default every field, so only the object
  // shape is checked.
  return (readLegacyJsonObject(indexPath) as HippoIndex | null) ?? empty;
}

function loadLegacyStatsFile(hippoRoot: string): LegacyStats {
  const statsPath = path.join(hippoRoot, 'stats.json');
  const empty: LegacyStats = { total_remembered: 0, total_recalled: 0, total_forgotten: 0, consolidation_runs: [] };
  if (!fs.existsSync(statsPath)) return empty;
  // SAFETY: callers guard every field read with `?? 0` / `Array.isArray`, so only the object shape is checked.
  return (readLegacyJsonObject(statsPath) as LegacyStats | null) ?? empty;
}
