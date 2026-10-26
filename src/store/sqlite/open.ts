// The store's handle types and the legacy setup a first open runs; src/store/sqlite/handles.ts opens hippo.db, the
// source of truth, and Markdown and JSON files are human-readable mirrors of it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_HALF_LIFE_DAYS, type StrengthModel } from '../../base/memory/strength.js';
import type { Clock } from '../../base/ports/infra.js';
import { type MemoryEntry, Layer } from '../../base/memory/entry.js';
import {
  type DatabaseSyncLike,
  openHippoDb,
  getMeta,
  setMeta,
  withWriteScope,
  pruneConsolidationRuns,
} from '../../db/index.js';
import { RejectedValueError } from '../../base/errors/api-errors.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { type HippoIndex } from './rows.js';
import type { LegacyStats } from '../../base/ports/store/reports.js';
import { audit } from './audit-event.js';
import { deserializeEntry } from '../../base/memory/markdown.js';
import { stampOriginProjectForImport, upsertEntryRow } from './entry-row.js';
import { layerDir } from './mirrors.js';
import { isJsonObject, type JsonValue } from '../../base/util/json.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import { createHost, type Host } from '../../host/host.js';
import { META_KEY } from '../../db/meta.js';
import { handleNow, handleStamp } from './handle-clock.js';

/** The strength model a store scores by and the clock its writes stamp by, both fixed when it opens. */
export interface StoreModel {
  readonly strength: StrengthModel;
  readonly clock: Clock;
}

/** The folder a store keeps its mirror files in, beside hippo.db, with the model its root opened it with; an adapter
 * hands it on and never reads it. `host` keeps the folder's project walk and shared flag for the store's life. */
export interface StoreFiles extends StoreModel {
  readonly hippoRoot: string;
  readonly host: Host;
}

export type HandleOpener = (hippoRoot: string) => DatabaseSyncLike;

/** One call on a handle of the store's own, closed after; `open` defaults to a bare handle, `openStore` also sets up
 * the mirror folders. */
export type OnHandle = <T>(fn: (db: DatabaseSyncLike, files: StoreFiles) => T, open?: HandleOpener) => T;

export type OnHandleAsync = <T>(
  fn: (db: DatabaseSyncLike, files: StoreFiles) => Promise<T>,
  open?: HandleOpener,
) => Promise<T>;

/** An opener that waits on a locked store for `busyWaitMs` in place of the default wait. */
export function waitingOpener(
  busyWaitMs: number | undefined,
  open: (hippoRoot: string, opts?: { busyWaitMs?: number }) => DatabaseSyncLike = openHippoDb,
): HandleOpener {
  return (hippoRoot) => open(hippoRoot, { busyWaitMs });
}

/** What an adapter gets of the store it serves: the openers and the files beside hippo.db, never the folder itself. */
export interface Handles {
  readonly on: OnHandle;
  readonly onAsync: OnHandleAsync;
  /** A bare handle the caller closes, for work that keeps one across several calls. */
  readonly open: () => DatabaseSyncLike;
  readonly files: StoreFiles;
}

/** Whether the store holds any memory row; existence, not COUNT(*), which would walk every row on each open. */
export function holdsMemory(db: DatabaseSyncLike): boolean {
  return db.prepare(`SELECT 1 AS x FROM memories LIMIT 1`).get() !== undefined;
}

/** A store with no memories starts on the current default half-life base so `hippo sleep` never migrates it; one that
 * holds memories but no recorded base predates the record and keeps the legacy 7-day base until sleep migrates it. */
export function recordHalfLifeBaseForNewStore(db: DatabaseSyncLike): void {
  if (getMeta(db, META_KEY.halfLifeBase, '') !== '') return;
  if (holdsMemory(db)) return;
  setMeta(db, META_KEY.halfLifeBase, String(DEFAULT_HALF_LIFE_DAYS));
  setMeta(db, META_KEY.typedHalfLife, '1');
}

/** Imports a markdown-era store's mirrors into an empty hippo.db once; true when it imported any row. */
export function bootstrapLegacyStore(db: DatabaseSyncLike, hippoRoot: string): boolean {
  if (holdsMemory(db)) return false;
  // The row check misses an all-rejected bootstrap (memories stays empty), which would re-run the import on every open
  // and duplicate consolidation_runs; this meta flag settles it.
  if (getMeta(db, META_KEY.legacyBootstrapCompleted, '0') === '1') return false;

  const legacyEntries = readLegacyMarkdownEntries(hippoRoot, handleNow(db));
  if (legacyEntries.length === 0) return false;

  withWriteScope(db, 'bootstrap_legacy_store', () => {
    importLegacyEntries(db, hippoRoot, legacyEntries, 'bootstrapLegacyStore');
    importLegacyIndexAndStats(db, hippoRoot);

    // Stamp completion even when every row was rejected; see the gate above.
    setMeta(db, META_KEY.legacyBootstrapCompleted, '1');
  });
  return true;
}

function importLegacyEntries(
  db: DatabaseSyncLike,
  hippoRoot: string,
  legacyEntries: MemoryEntry[],
  caller: string,
): void {
  // Guard live per row: a stale markdown mirror could resurrect a rejected value. Plain audit() inline, because nothing
  // rolls back on a per-row skip.
  let rejectedCount = 0;
  const host = createHost();
  for (const entry of legacyEntries) {
    // v39: legacy markdown carries no origin_project; stamp from the store location so bootstrapped rows stay visible
    // to ambient context.
    const stamped = stampOriginProjectForImport(host, hippoRoot, entry);
    try {
      upsertEntryRow(db, stamped);
    } catch (err) {
      if (err instanceof RejectedValueError) {
        rejectedCount++;
        audit(db, 'reject_refusal', {
          targetId: err.entryId,
          metadata: { digest: err.digest, reason: err.reason },
          actor: CLI_ACTOR,
          tenantId: err.tenantId,
        });
        continue;
      }
      throw err;
    }
  }
  if (rejectedCount > 0) {
    log.warn(`${caller}: skipped ${rejectedCount} rejected value(s) found in legacy mirrors`);
  }
}

function importLegacyIndexAndStats(db: DatabaseSyncLike, hippoRoot: string): void {
  const legacyIndex = readLegacyIndexFile(hippoRoot);
  setMeta(db, META_KEY.lastRetrievalIds, JSON.stringify(legacyIndex.last_retrieval_ids ?? []));
  // Legacy index.json predates last_trace_id, so '' is normal; accept only a clean digit string rather than trusting a
  // hand-edited or corrupt index.json.
  const legacyTraceId = String(legacyIndex.last_trace_id ?? '');
  setMeta(db, META_KEY.lastTraceId, /^\d+$/.test(legacyTraceId) ? legacyTraceId : '');

  const legacyStats = readLegacyStatsFile(hippoRoot);
  setMeta(db, META_KEY.totalRemembered, String(Number(legacyStats.total_remembered ?? 0)));
  setMeta(db, META_KEY.totalRecalled, String(Number(legacyStats.total_recalled ?? 0)));
  setMeta(db, META_KEY.totalForgotten, String(Number(legacyStats.total_forgotten ?? 0)));

  const runs = Array.isArray(legacyStats.consolidation_runs) ? legacyStats.consolidation_runs : [];
  const insertRun = db.prepare(
    `INSERT INTO consolidation_runs(timestamp, decayed, merged, removed) VALUES (?, ?, ?, ?)`,
  );
  for (const run of runs) {
    if (!isJsonObject(run)) continue;
    const row = run;
    insertRun.run(
      String(row.timestamp ?? handleStamp(db)),
      Number(row.decayed ?? 0),
      Number(row.merged ?? 0),
      Number(row.removed ?? 0),
    );
  }
  // Same cap as every later sleep, so stats.json and the table agree from the first open.
  pruneConsolidationRuns(db);
}

function readLegacyMarkdownEntries(hippoRoot: string, now: Date): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const layer of [Layer.Buffer, Layer.Episodic, Layer.Semantic]) {
    const dir = layerDir(hippoRoot, layer);
    if (!fs.existsSync(dir)) continue;

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      try {
        const entry = deserializeEntry(fs.readFileSync(path.join(dir, file), 'utf8'), now);
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

function readLegacyIndexFile(hippoRoot: string): HippoIndex {
  const indexPath = path.join(hippoRoot, 'index.json');
  const empty: HippoIndex = { version: 1, entries: {}, last_retrieval_ids: [], last_trace_id: null };
  if (!fs.existsSync(indexPath)) return empty;
  // SAFETY: index.json is written by writeIndexMirror as a HippoIndex; readers default every field, so only the object
  // shape is checked.
  return (readLegacyJsonObject(indexPath) as HippoIndex | null) ?? empty;
}

function readLegacyStatsFile(hippoRoot: string): LegacyStats {
  const statsPath = path.join(hippoRoot, 'stats.json');
  const empty: LegacyStats = { total_remembered: 0, total_recalled: 0, total_forgotten: 0, consolidation_runs: [] };
  if (!fs.existsSync(statsPath)) return empty;
  // SAFETY: callers guard every field read with `?? 0` / `Array.isArray`, so only the object shape is checked.
  return (readLegacyJsonObject(statsPath) as LegacyStats | null) ?? empty;
}
